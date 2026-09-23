# Third-party notices

## douyin-downloader-1

- Repository: https://github.com/zinan92/douyin-downloader-1
- Pinned commit: `b51225e695a9b8fff6eeb8b8178a53306f304f3a`
- Upstream version: `2.0.0`
- License: MIT
- Copyright: Copyright (c) 2026 jiji262
- License text: https://github.com/zinan92/douyin-downloader-1/blob/b51225e695a9b8fff6eeb8b8178a53306f304f3a/LICENSE
- Setup location: `vendor/douyin-downloader-1`

The upstream source is kept intact. Local scripts only provide D-drive runtime isolation, setup, configuration and execution entrypoints.

The upstream `analysis` output is rule-based and currently uses the first sentences of a transcript. It must not be represented as an AI semantic summary.

## video-batch-download

- Repository: https://github.com/ljb1020/video-batch-download
- Pinned commit: `be5e41cf7e95b3c3388790bcce91b8becb942ef1`
- License: MIT
- Copyright: Copyright (c) 2026 Lvjianbing
- License text: https://github.com/ljb1020/video-batch-download/blob/be5e41cf7e95b3c3388790bcce91b8becb942ef1/LICENSE
- Setup location: `vendor/video-batch-download`

This component provides browser-assisted public-work parsing, media download, resumable state and transcript orchestration. Its source is kept unchanged. Both upstream repositories are downloaded during setup and are not committed into this repository.

## Runtime dependencies

- Playwright: browser automation for authorized public profile enumeration and fallback parsing.
- faster-whisper: local speech-to-text inference.
- OpenCC `1.4.2`: transcript text conversion required by the transcription pipeline.
- FFmpeg: media inspection and audio extraction.

These dependencies are installed into the D-drive runtime or project-local environment. Their respective upstream licenses apply.
