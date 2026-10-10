//! Device possession proofs use one P-256 key per Keychain account lifecycle.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
  rand::SystemRandom,
  signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub(crate) const RECONNECT: &str =
  "Desktop device key is unavailable; disconnect and reconnect the desktop account";

#[derive(Clone, Default)]
pub(crate) struct DeviceKey(Option<Arc<EcdsaKeyPair>>);

#[derive(Serialize)]
struct PublicJwk {
  crv: &'static str,
  kty: &'static str,
  x: String,
  y: String,
}

impl DeviceKey {
  pub(crate) fn from_pkcs8(value: &[u8]) -> Result<Self, String> {
    EcdsaKeyPair::from_pkcs8(
      &ECDSA_P256_SHA256_FIXED_SIGNING,
      value,
      &SystemRandom::new(),
    )
    .map(|key| Self(Some(Arc::new(key))))
    .map_err(|_| RECONNECT.into())
  }

  pub(crate) fn generate() -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
      .map(|key| zeroize::Zeroizing::new(key.as_ref().to_vec()))
      .map_err(|_| "Could not create desktop device key".into())
  }

  fn public_jwk(&self) -> Result<PublicJwk, String> {
    let key = self.0.as_ref().ok_or(RECONNECT)?;
    let public = key.public_key().as_ref();
    Ok(PublicJwk {
      crv: "P-256",
      kty: "EC",
      x: URL_SAFE_NO_PAD.encode(&public[1..33]),
      y: URL_SAFE_NO_PAD.encode(&public[33..65]),
    })
  }

  pub(crate) fn thumbprint(&self) -> Result<String, String> {
    // RFC 7638 lexicographic member order is preserved by PublicJwk.
    let canonical = serde_json::to_vec(&self.public_jwk()?)
      .map_err(|_| "Could not encode desktop device key")?;
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(canonical)))
  }

  pub(crate) fn proof(
    &self,
    request: &reqwest::Request,
    bearer: Option<&str>,
    nonce: Option<&str>,
  ) -> Result<String, String> {
    let key = self.0.as_ref().ok_or(RECONNECT)?;
    let header =
      serde_json::json!({"typ":"dpop+jwt", "alg":"ES256", "jwk":self.public_jwk()?});
    let mut url = request.url().clone();
    url.set_query(None);
    url.set_fragment(None);
    let mut payload = serde_json::json!({
      "htm":request.method().as_str(), "htu":url.as_str(),
      "iat":chrono::Utc::now().timestamp(), "jti":uuid::Uuid::new_v4().to_string()
    });
    if let Some(bearer) = bearer {
      payload["ath"] = URL_SAFE_NO_PAD
        .encode(Sha256::digest(bearer.as_bytes()))
        .into();
    }
    if let Some(nonce) = nonce {
      payload["nonce"] = nonce.into();
    }
    let encode = |value: &serde_json::Value| {
      serde_json::to_vec(value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| "Could not encode desktop device proof".to_string())
    };
    let signing_input = format!("{}.{}", encode(&header)?, encode(&payload)?);
    let signature = key
      .sign(&SystemRandom::new(), signing_input.as_bytes())
      .map_err(|_| "Could not sign desktop device proof")?;
    Ok(format!(
      "{signing_input}.{}",
      URL_SAFE_NO_PAD.encode(signature.as_ref())
    ))
  }

  #[cfg(test)]
  pub(crate) fn fixture() -> Self {
    Self::from_pkcs8(&Self::generate().unwrap()).unwrap()
  }
}

trait DeviceKeyStorage {
  async fn load(&self) -> Result<Option<zeroize::Zeroizing<String>>, String>;
  async fn save(&mut self, value: zeroize::Zeroizing<String>) -> Result<(), String>;
  async fn clear(&mut self) -> Result<(), String>;
}

struct KeychainStorage;
impl DeviceKeyStorage for KeychainStorage {
  async fn load(&self) -> Result<Option<zeroize::Zeroizing<String>>, String> {
    crate::keychain::get_account_device_key()
      .await
      .map(|value| value.map(zeroize::Zeroizing::new))
  }
  async fn save(&mut self, value: zeroize::Zeroizing<String>) -> Result<(), String> {
    crate::keychain::store_account_device_key(value).await
  }
  async fn clear(&mut self) -> Result<(), String> {
    crate::keychain::delete_account_device_key().await
  }
}

fn decode_key(value: &str) -> Result<DeviceKey, String> {
  let bytes = zeroize::Zeroizing::new(
    URL_SAFE_NO_PAD
      .decode(value.as_bytes())
      .map_err(|_| RECONNECT)?,
  );
  DeviceKey::from_pkcs8(&bytes)
}

async fn required_from(storage: &impl DeviceKeyStorage) -> Result<DeviceKey, String> {
  let value = storage.load().await?.ok_or(RECONNECT)?;
  decode_key(&value)
}

pub(crate) async fn required() -> Result<DeviceKey, String> {
  required_from(&KeychainStorage).await
}

// The caller holds the account request lease. A staged key remains durable
// after a browser/opening failure and is reused by the next attempt.
async fn prepare_with(
  storage: &mut impl DeviceKeyStorage,
  has_link: bool,
) -> Result<DeviceKey, String> {
  if let Some(value) = storage.load().await? {
    match decode_key(&value) {
      Ok(key) => return Ok(key),
      Err(error) if has_link => return Err(error),
      Err(_) => storage.clear().await?,
    }
  }
  if has_link {
    return Err(RECONNECT.into());
  }
  let bytes = DeviceKey::generate()?;
  let key = DeviceKey::from_pkcs8(&bytes)?;
  storage
    .save(zeroize::Zeroizing::new(URL_SAFE_NO_PAD.encode(&bytes)))
    .await?;
  Ok(key)
}

pub(crate) async fn prepare(has_link: bool) -> Result<DeviceKey, String> {
  prepare_with(&mut KeychainStorage, has_link).await
}

async fn unlink_with(
  storage: &mut impl DeviceKeyStorage,
  clear_account: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
  // Preserve the account marker until the device key is gone, so a restart
  // still offers the reconnect path that retries cleanup.
  storage.clear().await?;
  clear_account.await
}

pub(crate) async fn unlink(
  clear_account: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
  unlink_with(&mut KeychainStorage, clear_account).await
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use crate::http_client::{
    DesktopHttpClient, HttpClientOptions, device_proof_request,
  };
  use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};

  #[derive(Default)]
  struct MemoryStorage {
    value: Option<zeroize::Zeroizing<String>>,
    writes: usize,
    fail_read: bool,
    fail_save: bool,
    fail_clear: bool,
  }
  impl DeviceKeyStorage for MemoryStorage {
    async fn load(&self) -> Result<Option<zeroize::Zeroizing<String>>, String> {
      if self.fail_read {
        return Err("Storage read failed".into());
      }
      Ok(self.value.clone())
    }
    async fn save(&mut self, value: zeroize::Zeroizing<String>) -> Result<(), String> {
      if self.fail_save {
        return Err("Storage save failed".into());
      }
      self.value = Some(value);
      self.writes += 1;
      Ok(())
    }
    async fn clear(&mut self) -> Result<(), String> {
      if self.fail_clear {
        return Err("Storage delete failed".into());
      }
      self.value = None;
      Ok(())
    }
  }

  #[tokio::test]
  async fn a_staged_key_survives_retries_and_credential_updates_until_explicit_unlink()
  {
    let mut storage = MemoryStorage::default();
    let original = prepare_with(&mut storage, false)
      .await
      .unwrap()
      .thumbprint()
      .unwrap();
    for has_link in [false, true, true, false] {
      let key = prepare_with(&mut storage, has_link).await.unwrap();
      assert_eq!(key.thumbprint().unwrap(), original);
      assert_eq!(
        required_from(&storage).await.unwrap().thumbprint().unwrap(),
        original
      );
    }
    assert_eq!(storage.writes, 1);
    storage.clear().await.unwrap();
    assert!(required_from(&storage).await.is_err());
    let replacement = prepare_with(&mut storage, false).await.unwrap();
    assert_ne!(replacement.thumbprint().unwrap(), original);
    assert_eq!(storage.writes, 2);
  }

  #[tokio::test]
  async fn an_unreadable_staged_key_is_replaced_before_the_first_connection() {
    let mut storage = MemoryStorage {
      value: Some(zeroize::Zeroizing::new("aW52YWxpZA".into())),
      ..MemoryStorage::default()
    };
    let key = prepare_with(&mut storage, false).await.unwrap();
    let thumbprint = key.thumbprint().unwrap();
    assert_eq!(storage.writes, 1);
    assert_eq!(
      required_from(&storage).await.unwrap().thumbprint().unwrap(),
      thumbprint
    );
    assert_eq!(
      prepare_with(&mut storage, false)
        .await
        .unwrap()
        .thumbprint()
        .unwrap(),
      thumbprint
    );
    assert_eq!(storage.writes, 1);
  }

  #[tokio::test]
  async fn an_existing_link_never_creates_a_missing_or_corrupt_device_key() {
    for value in [None, Some("invalid"), Some("aW52YWxpZA")] {
      let mut storage = MemoryStorage {
        value: value.map(|value| zeroize::Zeroizing::new(value.into())),
        ..MemoryStorage::default()
      };
      assert_eq!(
        prepare_with(&mut storage, true).await.err().unwrap(),
        RECONNECT
      );
      assert_eq!(required_from(&storage).await.err().unwrap(), RECONNECT);
      assert_eq!(storage.writes, 0);
    }
  }

  #[tokio::test]
  async fn storage_failures_leave_no_advertised_key_and_preserve_the_durable_key() {
    let mut storage = MemoryStorage {
      fail_read: true,
      ..MemoryStorage::default()
    };
    assert_eq!(
      prepare_with(&mut storage, false).await.err().unwrap(),
      "Storage read failed"
    );
    assert_eq!(storage.writes, 0);
    storage.fail_read = false;
    storage.fail_save = true;
    assert_eq!(
      prepare_with(&mut storage, false).await.err().unwrap(),
      "Storage save failed"
    );
    assert!(storage.value.is_none());
    storage.fail_save = false;
    let original = prepare_with(&mut storage, false)
      .await
      .unwrap()
      .thumbprint()
      .unwrap();
    storage.fail_clear = true;
    assert_eq!(storage.clear().await.unwrap_err(), "Storage delete failed");
    assert_eq!(
      required_from(&storage).await.unwrap().thumbprint().unwrap(),
      original
    );
  }

  #[tokio::test]
  async fn failed_device_key_deletion_keeps_reconnect_retryable_after_restart() {
    let mut account = Some("saved account");
    let mut storage = MemoryStorage {
      value: Some(zeroize::Zeroizing::new("unreadable key".into())),
      fail_clear: true,
      ..MemoryStorage::default()
    };
    assert_eq!(required_from(&storage).await.err().unwrap(), RECONNECT);
    assert_eq!(
      unlink_with(&mut storage, async {
        account = None;
        Ok(())
      })
      .await
      .unwrap_err(),
      "Storage delete failed"
    );

    // Restart from persisted records after the storage failure has cleared.
    let mut restarted_account = account;
    let mut restarted = MemoryStorage {
      value: storage.value,
      ..MemoryStorage::default()
    };
    assert!(restarted_account.is_some());
    assert_eq!(
      prepare_with(&mut restarted, restarted_account.is_some())
        .await
        .err()
        .unwrap(),
      RECONNECT
    );
    unlink_with(&mut restarted, async {
      restarted_account = None;
      Ok(())
    })
    .await
    .unwrap();
    assert!(restarted_account.is_none());
    let reconnected = prepare_with(&mut restarted, restarted_account.is_some())
      .await
      .unwrap();
    assert_eq!(
      required_from(&restarted)
        .await
        .unwrap()
        .thumbprint()
        .unwrap(),
      reconnected.thumbprint().unwrap()
    );
    assert_eq!(restarted.writes, 1);
  }

  pub(crate) fn verify_request(
    request: &reqwest::Request,
    expected_jkt: &str,
    bearer: Option<&str>,
    nonce: Option<&str>,
  ) -> serde_json::Value {
    let proof = request.headers()["dpop"].to_str().unwrap();
    let parts: Vec<_> = proof.split('.').collect();
    assert_eq!(parts.len(), 3);
    let header: serde_json::Value =
      serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    let claims: serde_json::Value =
      serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(header["typ"], "dpop+jwt");
    assert_eq!(header["alg"], "ES256");
    let jwk = &header["jwk"];
    assert_eq!(jwk.as_object().unwrap().len(), 4);
    assert_eq!(jwk["crv"], "P-256");
    assert_eq!(jwk["kty"], "EC");
    let canonical = format!(
      "{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{}\",\"y\":\"{}\"}}",
      jwk["x"].as_str().unwrap(),
      jwk["y"].as_str().unwrap()
    );
    assert_eq!(
      URL_SAFE_NO_PAD.encode(Sha256::digest(canonical)),
      expected_jkt
    );
    let mut public = vec![4];
    public.extend(URL_SAFE_NO_PAD.decode(jwk["x"].as_str().unwrap()).unwrap());
    public.extend(URL_SAFE_NO_PAD.decode(jwk["y"].as_str().unwrap()).unwrap());
    let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
    assert_eq!(signature.len(), 64);
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, public)
      .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
      .unwrap();
    assert_eq!(claims["htm"], request.method().as_str());
    let mut url = request.url().clone();
    url.set_query(None);
    url.set_fragment(None);
    assert_eq!(claims["htu"], url.as_str());
    assert!(claims["iat"].as_i64().is_some());
    assert_eq!(
      uuid::Uuid::parse_str(claims["jti"].as_str().unwrap())
        .unwrap()
        .get_version_num(),
      4
    );
    match bearer {
      Some(bearer) => {
        assert_eq!(
          claims["ath"],
          URL_SAFE_NO_PAD.encode(Sha256::digest(bearer.as_bytes()))
        );
        assert_eq!(
          request.headers()["authorization"].to_str().unwrap(),
          format!("Bearer {bearer}")
        );
      }
      None => {
        assert!(claims.get("ath").is_none());
        assert!(request.headers().get("authorization").is_none());
      }
    }
    assert_eq!(
      claims.get("nonce").and_then(serde_json::Value::as_str),
      nonce
    );
    claims
  }

  #[test]
  fn every_request_has_a_fresh_signed_proof_bound_to_its_url_method_bearer_and_nonce() {
    let key = DeviceKey::fixture();
    let jkt = key.thumbprint().unwrap();
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    let mut ids = std::collections::HashSet::new();
    for method in [
      reqwest::Method::GET,
      reqwest::Method::POST,
      reqwest::Method::DELETE,
    ] {
      for (bearer, nonce) in [
        (None, Some("correlation")),
        (Some("account-1"), Some("correlation")),
        (Some("account-2"), None),
      ] {
        for _ in 0..4 {
          let before = chrono::Utc::now().timestamp();
          let request = device_proof_request(
            client.request(
              method.clone(),
              "https://example.test:8443/v1/desktop?search=value#fragment",
            ),
            &key,
            bearer,
            nonce,
          )
          .unwrap()
          .build()
          .unwrap();
          let after = chrono::Utc::now().timestamp();
          let claims = verify_request(&request, &jkt, bearer, nonce);
          assert!(
            (before.min(after)..=before.max(after))
              .contains(&claims["iat"].as_i64().unwrap())
          );
          assert!(ids.insert(claims["jti"].as_str().unwrap().to_owned()));
        }
      }
    }
  }

  #[test]
  fn a_restored_key_keeps_its_thumbprint_and_an_empty_runtime_key_cannot_sign() {
    let bytes = DeviceKey::generate().unwrap();
    let key = DeviceKey::from_pkcs8(&bytes).unwrap();
    let restored = DeviceKey::from_pkcs8(&bytes).unwrap();
    assert_eq!(key.thumbprint().unwrap(), restored.thumbprint().unwrap());
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    assert_eq!(
      device_proof_request(
        client.post("https://example.test"),
        &DeviceKey::default(),
        Some("key"),
        None
      )
      .err()
      .unwrap(),
      RECONNECT
    );
  }
}
