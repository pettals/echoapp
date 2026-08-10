# Echo Production Tasks

## P0: Production Blockers

- [x] Add `PRD.md` and `TASKS.md`.
- [x] Add CI checks for TypeScript build and Rust `cargo check`.
- [x] Add Supabase Auth foundation: project env config, typed client wrapper, secure session persistence, and app launch session restore.
- [x] Configure Google OAuth for desktop auth callbacks and document required Supabase redirect URLs for development and production builds.
- [x] Add email/password auth: sign-up, login, password confirmation validation, weak-password feedback, and unverified-email recovery state.
- [x] Add logout flow in Settings and ensure signed-out users return to the auth/onboarding entry point without losing local app data.
- [x] Add setup/status UI for provider, model, mic, shortcut, and paste readiness.
- [x] Add Stripe lifetime-unlock foundation: Supabase billing tables, Checkout Session Edge Function, entitlement Edge Function, signed webhook grant path, and JWT/service-role boundaries.
- [x] Add online-required Echo Pro entitlement verification with account-scoped session lease and native enforcement for cloud/Groq and unlimited-history access.
- [x] Move Groq API key save/load behind OS secure storage while keeping config backwards compatible.
- [x] Harden Groq runtime integration with connection testing, typed API errors, upload preflight, and cleanup fallback.
- [x] Add shortcut validation, registration error UI, and retry guidance.
- [x] Add an F1-F24 shortcut picker with macOS Fn/Globe guidance and native validation coverage.
- [x] Add macOS permission help for Microphone and Accessibility.
- [x] Harden paste/focus behavior on macOS across Notes, Safari/Chrome, Slack, Mail, Messages, VS Code, and text fields in unfocused apps.
- [ ] Verify and fix Windows core loop: shortcut press/release, focus restore, clipboard write, paste simulation, settings, history, installer build.
- [x] Complete structured error codes beyond partial Groq/config coverage: missing local model, empty speech, mic unavailable, paste denied, and model download failure.

## P1: Solid Onboarding Phase

- [x] Add first-run auth gate before setup readiness with Google sign-in and email/password tabs.
- [x] Add OAuth callback/deep-link handling in Tauri so Google sign-in returns users to Echo and resumes onboarding.
- [x] Add auth loading, success, cancellation, network failure, invalid credentials, existing email, weak password, and unverified email UI states.
- [x] Add password reset entry point and recovery copy, even if full reset completion is deferred to Supabase-hosted email links.
- [x] Add a streamlined three-step first-run onboarding flow: branded welcome, microphone plus paste permissions, and hotkey dictation test.
- [x] Keep provider/model setup in Settings while onboarding surfaces a clear Settings next step when transcription readiness is missing.
- [x] Add microphone setup with device selection, permission guidance, live mic test, and a clear success/failure state.
- [x] Add hotkey capture and validation in onboarding while testing the default Command/Control+D shortcut through the actual global shortcut path.
- [x] Add macOS paste-permission onboarding for Accessibility, including System Settings deep link, trusted/untrusted status, and clipboard-copy fallback explanation.
- [x] Add Windows onboarding copy that avoids macOS-only Accessibility language while confirming clipboard/paste expectations.
- [x] Add a final hotkey test that validates the full loop: record, transcribe, paste or copy fallback, and history behavior.
- [x] Persist `onboarding_completed` after the user reaches a ready state and completes the first dictation test, or explicitly skips onboarding.
- [x] Add a lightweight way to reopen onboarding from Settings or the app menu for troubleshooting and reconfiguration.
- [x] Ensure onboarding error states always include the next action and never strand users on a generic Settings screen.
- [ ] Add auth onboarding QA coverage for new account, existing account, Google OAuth success/cancel/failure, email sign-up, email login, bad password, unverified email, logout, app relaunch session restore, and offline launch.
- [x] Add onboarding QA coverage to the manual matrix for fresh installs, returning users with existing config, denied permissions, skip path, Groq failure, local model failure, and Windows first run.

## P2: Product Completeness

- [x] Add Account section in Settings with signed-in identity, provider label, logout action, and privacy note that v1 history/notes/insights stay local.
- [x] Add Echo Pro account status, online checkout CTA, restore purchase action, and free-plan paywall prompts for cloud provider and unlimited local history.
- [x] Add Stripe Checkout billing deep links for `echo://billing/complete` and `echo://billing/cancel`, with direct checkout-session confirmation and entitlement polling retained as fallback.
- [x] Replace previous local entitlement-cache authorization with fresh online Supabase entitlement verification before Pro actions.
- [x] Add temporary local Whisper fallback and no-connection notice when cloud mode is selected but Pro cannot be verified during the session.
- [x] Add auth-aware route/state model so authenticated users continue into the existing setup flow, while signed-out users cannot skip required auth accidentally.
- [ ] Add tests for auth state transitions and onboarding routing where practical.
- [ ] Configure Stripe dashboard for Echo Pro lifetime product/price, webhook endpoint, live/test webhook secrets, branding, tax settings, and success/cancel URLs.
- [x] Deploy Supabase billing migration and Edge Functions with `STRIPE_SECRET_KEY`, `STRIPE_ECHO_PRO_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, and default checkout return URLs.
- [ ] Tighten Supabase advisor follow-ups from billing rollout: keep `stripe_webhook_events` service-only with RLS/no public policies documented as intentional, and update `public.set_updated_at` to use a fixed `search_path` in a future migration.
- [ ] Add automated coverage for billing Edge Functions: unauthenticated checkout/entitlement, duplicate webhook events, invalid Stripe signatures, paid checkout grant, and free/pro entitlement response shape.
- [ ] Add UI smoke coverage for free paywall prompts, checkout opening, billing deep-link return/cancel, restore purchase, paid-state rendering, online-required Pro verification, and local fallback when connectivity drops.
- [x] Add local model checksum/integrity validation and clearer disk-size messaging; partial download cleanup and retry UI are partially in place.
- [x] Add local transcription performance hardening: cached Whisper model reuse, calmer CPU thread control, safe timing diagnostics, and recording temp-file cleanup.
- [x] Add history clear confirmation and verify disabled-history UX.
- [x] Add transcription cleanup behavior documentation and preview copy for local mode.
- [x] Add local Notepad MVP with autosaved notes, markdown preview, and note-specific dictation insertion.
- [x] Add task-first Dictate insights disclosure with aggregate stats, nested safe diagnostics, and milestone celebrations.
- [x] Add proper app metadata: author, copyright, license notes, README production setup, and final icon polish; bundle icons are partially updated.
- [x] Add macOS signing/notarization workflow and Windows signing/MSI release workflow.
- [x] Add crash/log diagnostics suitable for support without exposing transcript/API key content.

## P3: Polish And Release Quality

- [x] Remove the dev-only "Skip sign in" auth bypass before production builds ship.
- [x] Refine desktop UI density and accessibility: focus states, keyboard navigation, reduced motion, contrast, text overflow, small-window behavior.
- [x] Revamp frontend with custom light/dark Echo design system: persistent desktop sidebar, dark dashboard surfaces, compact settings forms, redesigned HUD, and reduced-motion-aware transitions.
- [x] Apply Aureole frontend design system: dark-first coral token layer, fade navigation, pill actions, compact panels, local Aureole SVG icons, HUD/orb retokening, and desktop plus 360px visual QA target.
- [x] Redesign Settings as an Aureole workspace with fade-tab sections, command header, tokenized panels, neutral secondary actions, and desktop plus 360px visual QA target.
- [x] Apply macOS HIG polish pass: calmer SF Pro scale, top-leading dictation workspace, native grouped settings, durable HUD errors, and app menu commands.
- [x] Simplify Home and Settings for production: compact sidebar and native typography, task-first dictation state, collapsed insights, progressive grouped settings, contextual readiness, centralized Pro messaging, and dirty-only Save/Discard.
- [x] Audit customer-facing copy and icon use across auth, onboarding, Home, Settings, History, Notepad, HUD states, alerts, and empty/error states.
- [x] Add persistent Dynamic Island HUD with hover actions, live waveform recording, and no-target copy review.
- [x] Align the signed-in app with the new authentication and onboarding language: restrained gradient sidebar, white navigation, graphite and cool-neutral themes, monochrome actions, consistent form controls, tighter spacing, and isolated HUD styling.
- [x] Add Groq-first live transcript Dynamic Island with target app icon, rolling partial text, and local-provider fallback.
- [x] Remove MUI/Emotion and replace with lightweight custom components plus lucide icons.
- [x] Add bundle-size/code-splitting follow-up if startup performance regresses.
- [x] Finalize tray/menu wording and lifecycle QA: open, start/stop, settings, quit.
- [x] Add optional launch-at-login setting.
- [ ] Verify/document Windows sound behavior and media-ducking difference.
- [ ] Add automated UI smoke tests for settings/history where practical.
- [ ] Add manual QA checklist for macOS and Windows release candidates.

## Manual QA Matrix

- Authentication: Google OAuth first run and returning login, OAuth cancellation, email/password sign-up, existing-email handling, invalid login, unverified email, password reset entry point, logout, session restore after app restart, offline launch with existing session, and signed-out relaunch.
- Billing/paywall: free user sees Cloud and unlimited-history paywalls, checkout cancel leaves user free, Stripe test checkout returns through deep link or polling and unlocks Echo Pro, restore purchase refreshes Pro, lost connectivity relocks Pro features until Supabase verification returns, cloud mode temporarily falls back to local Whisper when a downloaded model is available, no-local-model offline state gives a reconnect/download next step, logout/login does not leak entitlement between accounts, and Groq API keys never appear in config, diagnostics, Supabase, or Stripe metadata.
- Onboarding: fresh installs, returning users with existing config, denied permissions, skip path, missing provider setup handoff, hotkey test failure, and Windows first run.
- macOS first run: provider setup handoff, mic denied/regranted, Accessibility denied/regranted, shortcut conflict, paste fallback, hidden window, tray/menu bar, dock indicator.
- Visual (custom Echo UI): dark/light/system themes, persistent compact sidebar, task-first Home, collapsed/expanded Insights, conditional setup and diagnostics, progressive grouped Settings, pristine/dirty action bar states, Dynamic Island HUD states, grouped History rows, local Notepad editor, and reduced motion.
- Responsive UI: verify Home and all Settings tabs at normal desktop width and compact widths around 900px, 740px, and 520px without hidden actions, clipped controls, or horizontal scrolling.
- Local transcription performance: first local dictation after launch may load the model, second dictation should report a model-cache hit, Balanced Auto should avoid saturating all CPU cores, and temp WAV recordings should not accumulate after completion or expected errors.
- macOS target apps: Notes, Safari, Chrome, Slack, Mail, Messages, VS Code, and browser text fields.
- Windows first run: shortcut, recording, paste/copy fallback, history, settings, local model download/transcription, and installer launch.
- Release checks: build production bundles on macOS and Windows and test on clean machines/accounts.
