//! Fixed Noise suite; the maintained snow implementation owns all cryptography.
use super::{
    protocol::{encode_base64, key, MAX_SAFE_INTEGER},
    RemoteError, Result,
};

pub const NOISE_SUITE: &str = "Noise_IK_25519_ChaChaPoly_SHA256";

/// No Debug/Serialize implementation: a device private key must not enter logs or IPC.
#[derive(Clone)]
pub struct DeviceIdentity {
    pub device_id: String,
    private_key: [u8; 32],
    pub public_key: String,
}
impl DeviceIdentity {
    pub fn generate(device_id: String) -> Result<Self> {
        let pair = builder()?.generate_keypair().map_err(noise_error)?;
        Ok(Self {
            device_id,
            private_key: pair
                .private
                .as_slice()
                .try_into()
                .map_err(|_| RemoteError::invalid("Invalid generated private key"))?,
            public_key: encode_base64(&pair.public),
        })
    }
    /// Restore a credential-store key. Its public key is derived by snow.
    pub fn restore(device_id: String, private_key: &str) -> Result<Self> {
        let private_key = key(private_key)?;
        // crypto_box already provides the standard clamped X25519 public-key
        // derivation used by snow; no protocol state machine is reimplemented.
        let secret = crypto_box::SecretKey::from(private_key);
        let public_key = encode_base64(secret.public_key().as_bytes());
        Ok(Self {
            device_id,
            private_key,
            public_key,
        })
    }
    /// Intended only for writing to a platform credential store.
    pub fn private_key_for_storage(&self) -> String {
        encode_base64(&self.private_key)
    }
}
impl Drop for DeviceIdentity {
    fn drop(&mut self) {
        self.private_key.fill(0);
    }
}

pub fn prologue(connection: &str, host: &str, client: &str) -> Result<Vec<u8>> {
    if [connection, host, client]
        .iter()
        .any(|s| s.is_empty() || s.contains('\0'))
    {
        return Err(RemoteError::invalid("Unsafe Noise prologue identifier"));
    }
    Ok(
        format!("DSH-REMOTE\0v=1\0connection={connection}\0host={host}\0client={client}")
            .into_bytes(),
    )
}
pub(crate) fn builder<'a>() -> Result<snow::Builder<'a>> {
    Ok(snow::Builder::new(
        NOISE_SUITE.parse().map_err(noise_error)?,
    ))
}
pub(crate) fn noise_error(_: snow::Error) -> RemoteError {
    RemoteError::new(
        "SECURE_CHANNEL_FAILED",
        "Noise authentication or state validation failed",
    )
}

pub struct Initiator {
    handshake: snow::HandshakeState,
    expected: [u8; 32],
}
impl Initiator {
    pub fn new(identity: &DeviceIdentity, pinned_host_key: &str, prologue: &[u8]) -> Result<Self> {
        let expected = key(pinned_host_key)?;
        let handshake = builder()?
            .local_private_key(&identity.private_key)
            .remote_public_key(&expected)
            .prologue(prologue)
            .build_initiator()
            .map_err(noise_error)?;
        Ok(Self {
            handshake,
            expected,
        })
    }
    pub fn first_message(&mut self) -> Result<Vec<u8>> {
        let mut bytes = vec![0; 128];
        let size = self
            .handshake
            .write_message(&[], &mut bytes)
            .map_err(noise_error)?;
        bytes.truncate(size);
        Ok(bytes)
    }
    pub fn finish(mut self, response: &[u8]) -> Result<SecureChannel> {
        if response.len() > 65535 {
            return Err(RemoteError::invalid("Oversized handshake"));
        }
        let mut payload = vec![0; response.len()];
        self.handshake
            .read_message(response, &mut payload)
            .map_err(noise_error)?;
        if !self.handshake.is_handshake_finished()
            || self.handshake.get_remote_static() != Some(self.expected.as_slice())
        {
            return Err(RemoteError::new(
                "PEER_IDENTITY_MISMATCH",
                "Noise peer differs from the pinned Host identity",
            ));
        }
        Ok(SecureChannel {
            state: self.handshake.into_transport_mode().map_err(noise_error)?,
            sending: 0,
            receiving: 0,
        })
    }
}

pub struct SecureChannel {
    state: snow::TransportState,
    sending: u64,
    receiving: u64,
}
impl SecureChannel {
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<(u64, Vec<u8>)> {
        if plaintext.len() + 16 > 65535 || self.sending >= MAX_SAFE_INTEGER {
            return Err(RemoteError::invalid("Noise transport limit reached"));
        }
        let mut ciphertext = vec![0; plaintext.len() + 16];
        let size = self
            .state
            .write_message(plaintext, &mut ciphertext)
            .map_err(noise_error)?;
        ciphertext.truncate(size);
        let counter = self.sending;
        self.sending += 1;
        Ok((counter, ciphertext))
    }
    pub fn decrypt(&mut self, counter: u64, ciphertext: &[u8]) -> Result<Vec<u8>> {
        if counter != self.receiving
            || counter >= MAX_SAFE_INTEGER
            || !(16..=65535).contains(&ciphertext.len())
        {
            return Err(RemoteError::invalid(
                "Duplicate, out-of-order or oversized Noise frame",
            ));
        }
        let mut plaintext = vec![0; ciphertext.len() - 16];
        let size = self
            .state
            .read_message(ciphertext, &mut plaintext)
            .map_err(noise_error)?;
        plaintext.truncate(size);
        self.receiving += 1;
        Ok(plaintext)
    }
}
