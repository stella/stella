# OpenSSL detached signatures

Synthetic interoperability fixtures produced with OpenSSL 4.1 from
`signed.txt` and a throwaway self-signed P-256 certificate
(`CN=Example interoperability signer, O=Example office`). The private key was
not kept. Readers report the stated signer and digest; nothing here is ever
verified.

```sh
openssl cms -sign -binary -in signed.txt -signer cert.pem -inkey key.pem -outform DER -out signed.txt.p7s -md sha256
openssl cms -sign -binary -in signed.txt -signer cert.pem -inkey key.pem -outform PEM -out signed.txt.pem.sig -md sha384
openssl smime -sign -binary -in signed.txt -signer cert.pem -inkey key.pem -outform DER -out signed.txt.smime.p7s -md sha1
```
