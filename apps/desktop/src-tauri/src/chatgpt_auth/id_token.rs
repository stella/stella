//! ID-token verification: the signature against the issuer's JWKS (RS256 or
//! ES256), then issuer, audience, expiry, nonce and subject.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{
  ECDSA_P256_SHA256_FIXED, RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents,
  UnparsedPublicKey,
};
use serde::Deserialize;
use serde_json::Value;

/// Allowed clock difference, in seconds.
const CLOCK_SKEW_SECONDS: i64 = 5;
/// An ID token is verified right after the exchange that issued it; an
/// older one is a replay.
const MAX_AGE_SECONDS: i64 = 10 * 60;
const MAX_TOKEN_BYTES: usize = 32 * 1024;
const AUTH_CLAIMS: &str = "https://api.openai.com/auth";

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Jwks {
  pub keys: Vec<Jwk>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Jwk {
  pub kty: String,
  #[serde(default)]
  pub kid: Option<String>,
  #[serde(default)]
  pub alg: Option<String>,
  #[serde(default, rename = "use")]
  pub key_use: Option<String>,
  #[serde(default)]
  pub n: Option<String>,
  #[serde(default)]
  pub e: Option<String>,
  #[serde(default)]
  pub crv: Option<String>,
  #[serde(default)]
  pub x: Option<String>,
  #[serde(default)]
  pub y: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IdTokenError {
  Malformed,
  UnsupportedAlgorithm,
  /// No key with the token's `kid`; the JWKS may have rotated.
  UnknownKey,
  Signature,
  Issuer,
  Audience,
  Expired,
  Nonce,
  Subject,
  /// Issued in the future, or too long ago for a fresh sign-in.
  IssuedAt,
}

pub(crate) struct Expectations<'a> {
  pub issuer: &'a str,
  pub client_id: &'a str,
  pub nonce: &'a str,
  /// Unix seconds.
  pub now: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedIdentity {
  pub subject: String,
  pub email: Option<String>,
  pub plan: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Algorithm {
  Rs256,
  Es256,
}

#[derive(Deserialize)]
struct Header {
  alg: String,
  #[serde(default)]
  kid: Option<String>,
}

fn decode(segment: &str) -> Result<Vec<u8>, IdTokenError> {
  URL_SAFE_NO_PAD
    .decode(segment)
    .map_err(|_invalid| IdTokenError::Malformed)
}

/// Verifies `token` and returns the identity it names.
pub(crate) fn verify(
  token: &str,
  jwks: &Jwks,
  expect: &Expectations<'_>,
) -> Result<VerifiedIdentity, IdTokenError> {
  if token.len() > MAX_TOKEN_BYTES {
    return Err(IdTokenError::Malformed);
  }
  let mut parts = token.split('.');
  let (Some(header), Some(payload), Some(signature), None) =
    (parts.next(), parts.next(), parts.next(), parts.next())
  else {
    return Err(IdTokenError::Malformed);
  };
  let parsed: Header = serde_json::from_slice(&decode(header)?)
    .map_err(|_invalid| IdTokenError::Malformed)?;
  let algorithm = match parsed.alg.as_str() {
    "RS256" => Algorithm::Rs256,
    "ES256" => Algorithm::Es256,
    _ => return Err(IdTokenError::UnsupportedAlgorithm),
  };
  let key = select_key(jwks, algorithm, parsed.kid.as_deref())?;
  let signing_input = &token[..header.len() + 1 + payload.len()];
  verify_signature(
    algorithm,
    key,
    signing_input.as_bytes(),
    &decode(signature)?,
  )?;

  let claims: Value = serde_json::from_slice(&decode(payload)?)
    .map_err(|_invalid| IdTokenError::Malformed)?;
  check_claims(&claims, expect)
}

fn select_key<'a>(
  jwks: &'a Jwks,
  algorithm: Algorithm,
  kid: Option<&str>,
) -> Result<&'a Jwk, IdTokenError> {
  let kty = match algorithm {
    Algorithm::Rs256 => "RSA",
    Algorithm::Es256 => "EC",
  };
  let alg = match algorithm {
    Algorithm::Rs256 => "RS256",
    Algorithm::Es256 => "ES256",
  };
  let usable = |key: &&Jwk| {
    key.kty == kty
      && key.alg.as_deref().is_none_or(|key_alg| key_alg == alg)
      && key
        .key_use
        .as_deref()
        .is_none_or(|key_use| key_use == "sig")
  };
  match kid {
    Some(kid) => jwks
      .keys
      .iter()
      .filter(usable)
      .find(|key| key.kid.as_deref() == Some(kid))
      .ok_or(IdTokenError::UnknownKey),
    None => {
      let mut candidates = jwks.keys.iter().filter(usable);
      match (candidates.next(), candidates.next()) {
        (Some(key), None) => Ok(key),
        _ => Err(IdTokenError::UnknownKey),
      }
    }
  }
}

fn verify_signature(
  algorithm: Algorithm,
  key: &Jwk,
  message: &[u8],
  signature: &[u8],
) -> Result<(), IdTokenError> {
  let component = |value: &Option<String>| {
    value
      .as_deref()
      .ok_or(IdTokenError::Signature)
      .and_then(|value| decode(value).map_err(|_invalid| IdTokenError::Signature))
  };
  match algorithm {
    Algorithm::Rs256 => RsaPublicKeyComponents {
      n: component(&key.n)?,
      e: component(&key.e)?,
    }
    .verify(&RSA_PKCS1_2048_8192_SHA256, message, signature)
    .map_err(|_rejected| IdTokenError::Signature),
    Algorithm::Es256 => {
      if key.crv.as_deref() != Some("P-256") {
        return Err(IdTokenError::Signature);
      }
      let (x, y) = (component(&key.x)?, component(&key.y)?);
      if x.len() != 32 || y.len() != 32 {
        return Err(IdTokenError::Signature);
      }
      let point = [&[0x04][..], &x, &y].concat();
      UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point)
        .verify(message, signature)
        .map_err(|_rejected| IdTokenError::Signature)
    }
  }
}

fn check_claims(
  claims: &Value,
  expect: &Expectations<'_>,
) -> Result<VerifiedIdentity, IdTokenError> {
  if claims.get("iss").and_then(Value::as_str) != Some(expect.issuer) {
    return Err(IdTokenError::Issuer);
  }
  let audiences: Vec<&str> = match claims.get("aud") {
    Some(Value::String(audience)) => vec![audience.as_str()],
    Some(Value::Array(audiences)) => audiences
      .iter()
      .map(|audience| audience.as_str().ok_or(IdTokenError::Malformed))
      .collect::<Result<_, _>>()?,
    _ => return Err(IdTokenError::Audience),
  };
  if !audiences.contains(&expect.client_id) {
    return Err(IdTokenError::Audience);
  }
  // OpenID Connect Core 3.1.3.7: with several audiences the authorized party
  // must be this client, and when present it must always be.
  match claims.get("azp") {
    Some(Value::String(party)) if party != expect.client_id => {
      return Err(IdTokenError::Audience);
    }
    Some(Value::String(_)) => {}
    None if audiences.len() > 1 => return Err(IdTokenError::Audience),
    None => {}
    Some(_) => return Err(IdTokenError::Malformed),
  }
  let expires = claims
    .get("exp")
    .and_then(Value::as_i64)
    .ok_or(IdTokenError::Expired)?;
  if expires.saturating_add(CLOCK_SKEW_SECONDS) <= expect.now {
    return Err(IdTokenError::Expired);
  }
  let issued = claims
    .get("iat")
    .and_then(Value::as_i64)
    .ok_or(IdTokenError::Malformed)?;
  if issued.saturating_sub(CLOCK_SKEW_SECONDS) > expect.now
    || issued.saturating_add(MAX_AGE_SECONDS) < expect.now
  {
    return Err(IdTokenError::IssuedAt);
  }
  if claims
    .get("nbf")
    .and_then(Value::as_i64)
    .is_some_and(|not_before| {
      not_before.saturating_sub(CLOCK_SKEW_SECONDS) > expect.now
    })
  {
    return Err(IdTokenError::Expired);
  }
  if claims.get("nonce").and_then(Value::as_str) != Some(expect.nonce) {
    return Err(IdTokenError::Nonce);
  }
  let subject = claims
    .get("sub")
    .and_then(Value::as_str)
    .filter(|subject| !subject.is_empty())
    .ok_or(IdTokenError::Subject)?;
  Ok(VerifiedIdentity {
    subject: subject.to_owned(),
    email: claims
      .get("email")
      .and_then(Value::as_str)
      .filter(|email| !email.is_empty())
      .map(str::to_owned),
    plan: claims
      .get(AUTH_CLAIMS)
      .and_then(|auth| auth.get("chatgpt_plan_type"))
      .and_then(Value::as_str)
      .filter(|plan| !plan.is_empty())
      .map(str::to_owned),
  })
}

/// A local ES256 issuer for tests: its own key, JWKS and signed tokens.
#[cfg(test)]
pub(crate) mod fake_issuer {
  use super::*;
  use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair},
  };

  pub(crate) struct FakeIssuer {
    key: EcdsaKeyPair,
    pub kid: String,
  }

  impl FakeIssuer {
    pub(crate) fn new(kid: &str) -> Self {
      let random = SystemRandom::new();
      let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &random)
          .unwrap();
      let key = EcdsaKeyPair::from_pkcs8(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        pkcs8.as_ref(),
        &random,
      )
      .unwrap();
      Self {
        key,
        kid: kid.to_owned(),
      }
    }

    pub(crate) fn jwks_json(&self) -> Value {
      let point = self.key.public_key().as_ref();
      serde_json::json!({
        "keys": [{
          "kty": "EC",
          "crv": "P-256",
          "kid": self.kid,
          "alg": "ES256",
          "use": "sig",
          "x": URL_SAFE_NO_PAD.encode(&point[1..33]),
          "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
        }]
      })
    }

    pub(crate) fn jwks(&self) -> Jwks {
      serde_json::from_value(self.jwks_json()).unwrap()
    }

    pub(crate) fn sign(&self, claims: &Value) -> String {
      let header = serde_json::json!({ "alg": "ES256", "kid": self.kid, "typ": "JWT" });
      let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
      );
      let signature = self
        .key
        .sign(&SystemRandom::new(), input.as_bytes())
        .unwrap();
      format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{fake_issuer::FakeIssuer, *};
  use serde_json::json;

  const NOW: i64 = 1_790_000_000;

  fn claims() -> Value {
    json!({
      "iss": "https://issuer.test",
      "sub": "subject-1",
      "aud": ["oaiapp_client"],
      "nonce": "nonce-1",
      "email": "person@example.com",
      "iat": NOW - 10,
      "exp": NOW + 3600,
      AUTH_CLAIMS: { "chatgpt_plan_type": "plus" },
    })
  }

  fn expect() -> Expectations<'static> {
    Expectations {
      issuer: "https://issuer.test",
      client_id: "oaiapp_client",
      nonce: "nonce-1",
      now: NOW,
    }
  }

  #[test]
  fn a_signed_token_with_matching_claims_verifies() {
    let issuer = FakeIssuer::new("k1");
    assert_eq!(
      verify(&issuer.sign(&claims()), &issuer.jwks(), &expect()),
      Ok(VerifiedIdentity {
        subject: "subject-1".into(),
        email: Some("person@example.com".into()),
        plan: Some("plus".into()),
      })
    );
    let mut single = claims();
    single["aud"] = json!("oaiapp_client");
    assert!(verify(&issuer.sign(&single), &issuer.jwks(), &expect()).is_ok());
  }

  #[test]
  fn each_failed_claim_is_refused() {
    let issuer = FakeIssuer::new("k1");
    let cases: [(&str, Value, IdTokenError); 7] = [
      ("iss", json!("https://other.test"), IdTokenError::Issuer),
      ("aud", json!(["oaiapp_other"]), IdTokenError::Audience),
      ("exp", json!(NOW - 60), IdTokenError::Expired),
      ("nbf", json!(NOW + 600), IdTokenError::Expired),
      ("nonce", json!("nonce-2"), IdTokenError::Nonce),
      ("sub", json!(""), IdTokenError::Subject),
      ("iat", Value::Null, IdTokenError::Malformed),
    ];
    for (claim, value, error) in cases {
      let mut changed = claims();
      if value.is_null() {
        changed.as_object_mut().unwrap().remove(claim);
      } else {
        changed[claim] = value;
      }
      assert_eq!(
        verify(&issuer.sign(&changed), &issuer.jwks(), &expect()),
        Err(error),
        "{claim}"
      );
    }
  }

  #[test]
  fn the_issue_time_must_be_recent_and_not_ahead() {
    let issuer = FakeIssuer::new("k1");
    for (iat, expected) in [
      (NOW - 10, Ok(())),
      (NOW + 3, Ok(())),
      (NOW + 60, Err(IdTokenError::IssuedAt)),
      (NOW - MAX_AGE_SECONDS - 1, Err(IdTokenError::IssuedAt)),
      (i64::MIN, Err(IdTokenError::IssuedAt)),
    ] {
      let mut changed = claims();
      changed["iat"] = json!(iat);
      assert_eq!(
        verify(&issuer.sign(&changed), &issuer.jwks(), &expect()).map(|_| ()),
        expected,
        "{iat}"
      );
    }
  }

  #[test]
  fn several_audiences_need_this_client_as_authorized_party() {
    let issuer = FakeIssuer::new("k1");
    let with = |aud: Value, azp: Option<&str>| {
      let mut changed = claims();
      changed["aud"] = aud;
      if let Some(azp) = azp {
        changed["azp"] = json!(azp);
      }
      verify(&issuer.sign(&changed), &issuer.jwks(), &expect()).map(|_| ())
    };
    let both = || json!(["oaiapp_client", "oaiapp_other"]);
    assert_eq!(with(both(), None), Err(IdTokenError::Audience));
    assert_eq!(with(both(), Some("oaiapp_client")), Ok(()));
    assert_eq!(
      with(both(), Some("oaiapp_other")),
      Err(IdTokenError::Audience)
    );
    assert_eq!(
      with(json!(["oaiapp_client"]), Some("oaiapp_other")),
      Err(IdTokenError::Audience)
    );
    assert_eq!(
      with(json!(["oaiapp_client", 7]), None),
      Err(IdTokenError::Malformed)
    );
  }

  #[test]
  fn another_issuers_key_or_a_tampered_token_is_refused() {
    let issuer = FakeIssuer::new("k1");
    let impostor = FakeIssuer::new("k1");
    assert_eq!(
      verify(&impostor.sign(&claims()), &issuer.jwks(), &expect()),
      Err(IdTokenError::Signature)
    );
    let token = issuer.sign(&claims());
    let mut parts: Vec<&str> = token.split('.').collect();
    let mut forged = claims();
    forged["sub"] = json!("subject-2");
    let forged_payload = URL_SAFE_NO_PAD.encode(forged.to_string());
    parts[1] = &forged_payload;
    assert_eq!(
      verify(&parts.join("."), &issuer.jwks(), &expect()),
      Err(IdTokenError::Signature)
    );
    assert_eq!(
      verify(
        &FakeIssuer::new("k2").sign(&claims()),
        &issuer.jwks(),
        &expect()
      ),
      Err(IdTokenError::UnknownKey)
    );
  }

  #[test]
  fn unsigned_and_symmetric_tokens_are_refused() {
    let issuer = FakeIssuer::new("k1");
    for alg in ["none", "HS256"] {
      let header =
        URL_SAFE_NO_PAD.encode(json!({ "alg": alg, "kid": "k1" }).to_string());
      let payload = URL_SAFE_NO_PAD.encode(claims().to_string());
      assert_eq!(
        verify(&format!("{header}.{payload}."), &issuer.jwks(), &expect()),
        Err(IdTokenError::UnsupportedAlgorithm)
      );
    }
    assert_eq!(
      verify("not-a-token", &issuer.jwks(), &expect()),
      Err(IdTokenError::Malformed)
    );
  }

  /// RFC 7515 appendix A.2: an RS256 JWS and its public key.
  #[test]
  fn rs256_signatures_verify_against_rsa_keys() {
    let n = concat!(
      "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddx",
      "HmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMs",
      "D1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSH",
      "SXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdV",
      "MTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8",
      "NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ",
    );
    let input = concat!(
      "eyJhbGciOiJSUzI1NiJ9",
      ".",
      "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFt",
      "cGxlLmNvbS9pc19yb290Ijp0cnVlfQ",
    );
    let signature = concat!(
      "cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7",
      "AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4",
      "BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K",
      "0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqv",
      "hJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrB",
      "p0igcN_IoypGlUPQGe77Rw",
    );
    let key = Jwk {
      kty: "RSA".into(),
      kid: None,
      alg: None,
      key_use: None,
      n: Some(n.into()),
      e: Some("AQAB".into()),
      crv: None,
      x: None,
      y: None,
    };
    let signature = decode(signature).unwrap();
    assert_eq!(
      verify_signature(Algorithm::Rs256, &key, input.as_bytes(), &signature),
      Ok(())
    );
    assert_eq!(
      verify_signature(Algorithm::Rs256, &key, b"tampered", &signature),
      Err(IdTokenError::Signature)
    );
    // Through the whole token path the RFC claims fail only on the claims.
    let jwks = Jwks { keys: vec![key] };
    assert_eq!(
      verify(
        &format!("{input}.{}", URL_SAFE_NO_PAD.encode(&signature)),
        &jwks,
        &expect()
      ),
      Err(IdTokenError::Issuer)
    );
  }
}
