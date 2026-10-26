# Echo License Notes

Copyright (c) 2026 Pettal Technology. All rights reserved.

Echo is planned as a freemium commercial product from Pettal Technology. Production customer distribution, pricing, entitlement checks, and end-user terms are separate release work and are not represented by an open-source production license in this repository.

MIT-style development licensing may be used for internal development or explicitly marked development-only distributions, but do not present production Echo builds as MIT-licensed unless Pettal Technology adds a formal production license file and release terms.

Third-party dependencies keep their own licenses. Review dependency notices before shipping signed production installers.

The macOS Bark runtime includes FluidAudio v0.17.7 (Apache-2.0; full license in `native/bark/Notices/FluidAudio-LICENSE.txt`). Bark 3 Clean is by Conway Research, derived from NVIDIA parakeet-tdt-0.6b-v3 through moondream/parakeet-ultra, under CC-BY-4.0. Echo uses FluidInference's Core ML conversion; the conversion changes the storage/runtime representation. Original attribution is preserved in `native/bark/Notices/Bark-NOTICE.txt` and the downloaded model's verified `NOTICE`. Source links and pinned revisions are documented in `native/bark/README.md`. These notices are bundled with macOS releases.

- Meeting notes use Qwen3.5-4B (Apache 2.0), its pinned Unsloth Q4_K_M conversion, and llama.cpp (MIT). Bundles include the upstream and selected vendor notices in `MeetingNotices`; model metadata is pinned in `src-tauri/notes-manifest.json`.
