# Local-first Meetings

Echo Pro Meetings records microphone audio for in-person meetings and adds
computer audio for online meetings. Supported systems are macOS 13+ and Windows
10/11 x64. Bark Clean needs Apple Silicon/macOS 15+; other systems use Whisper.
The initial transcription language is English. Meetings uses separate model
preferences from dictation. Default microphone/output devices are used.

## Local processing and storage

The default summary provider is **On-device**. Users download transcription
weights plus Qwen3.5-4B Q4_K_M (2,740,937,888 bytes). After model installation and
one signed Pro purchase verification, recording, transcription and notes work
offline. Model integrity and available-memory errors preserve the transcript.

The library is stored in the operating system's local application-data directory,
under `echo/meetings/meetings.sqlite`. It is independent of dictation-history
settings and limits. Notes, raw ASR segments, assembled transcript, metadata and
processing state are local. Existing meetings remain accessible after sign-out,
purchase revocation or lost connectivity. Deleting a meeting removes its text and
remaining recording files; deletion is permanent.

Temporary WAV chunks and recovery journals live under the same private library.
After each successful transcript commit, its audio is deleted, even before notes
finish. Interrupted/unprocessed audio is retained only for recovery or explicit
discard. Failed summary requests can be retried from saved text. Processed audio
is not retained for replay. Copy and explicit Markdown/text export are available;
exports are written to **Downloads / Echo Meetings**.

Long transcripts are processed in bounded chronological sections. Echo combines
the cited discussion points, decisions, actions and questions without dropping
them to fit a model output window; the local model condenses only the overview
and title in further passes. A failed pass leaves the transcript and previous
successful notes available for retry.

Online capture can include notification audio or other playback. Use headphones,
set the meeting app to the system's default output, and let participants know
that recording is active. ScreenCaptureKit may request Screen & System Audio
Recording permission; in-person mode requires only the microphone. Echo does not
save video or identify individual speakers.

## Optional cloud AI

OpenAI, Google Gemini and Anthropic (Claude) are optional, user-funded providers.
Each key is held separately in macOS Keychain or Windows Credential Manager and
is never returned by the credential-status API or written to JSON config/logs.
Saving a key does not change the provider. Users must select that provider,
accept the transcript-transmission disclosure and save settings. Echo sends only
transcript text directly to it; audio stays local. No Echo AI proxy is involved,
and there is no automatic provider/cloud fallback. Provider retention policies
apply; local storage does not imply that a selected external provider retains
nothing. OpenAI requests set `store:false`.

Provider connection tests send a small synthetic JSON request, not meeting
content. Errors keep the transcript and previous successful notes intact.

## Offline Pro licensing: release provisioning

The `get-meetings-license` Edge Function verifies Supabase Auth and the existing
active `pro_lifetime` billing entitlement. It signs a non-expiring Ed25519 licence
bound to the account, audience and Meetings feature. Rust verifies the signature
against the shipped public key ring. A cached frontend entitlement flag cannot
authorize Meetings. Sign-out clears the active account context, while stored
meetings remain readable. A successful online inactive entitlement response
removes that account's local licence; network/auth errors do not revoke it.

**Release gate:** this checkout begins with an empty public-key ring. The correct
Echo backend account must be connected and signing secrets provisioned before
Meetings can authorize recording/generation in a customer build. Never ship an
empty ring or a private signing key in the app/repository.

1. Run `node scripts/configure-meetings-license.mjs --key-id <unique-id> --secrets-file <private-temp-file-outside-repo>`.
2. Commit the generated **public** key ring. Upload the private secrets file to
   the Echo project's Edge Function secrets (`MEETINGS_LICENSE_PRIVATE_KEY` and
   `MEETINGS_LICENSE_KEY_ID`), then securely remove the temporary file.
3. Deploy `get-meetings-license`, including `_shared/meeting-license.mjs`, with JWT
   verification enabled. The existing billing schema does not change.
4. Verify signed issuance, account mismatch, tampering, offline restart and an
   authoritative revocation using a test Pro account. Only account/billing
   metadata reaches this endpoint; meeting content and provider keys never do.
5. Build and sign both platform packages after provisioning; complete the manual
   real-device matrix before publishing. Keep prior verification keys during key
   rotation so existing perpetual licences continue to work.

Signing unit tests: `node scripts/test-meetings-license.mjs`; Rust tests cover
verification and rejected tampering/account binding. Do not print private key
material, credentials or real meeting content in test output.
