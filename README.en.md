# Interview Assistant

A job-hunting copilot covering four stages: preparation, live interview listening, review, and resume plus auto-apply. Split channels identify the interviewer and you separately, so answers are never guessed.

## During the interview

- **Two-channel capture** - system loopback is the interviewer, microphone is you; speaker attribution does not rely on model inference. The left channel is the interviewer, the right channel is you in the saved stereo recording.
- **Per-question output** - question text, your answer, a spoken-style answer you can say out loud, key-point coverage and follow-up warnings.
- **Session records** - each session is stored under `interview-sessions/<session>/` and merged into one WAV at the end.

## Mock interview

- Paste a job description; the AI plans questions with assessment points.
- One short question at a time, voice selectable (local / Edge cloud / Seed Audio / cloned).
- Answer out loud - live transcription detects a ~1.5 s pause and hands control back automatically, no button clicking.
- Five-dimension review report at the end.

## Resume, question bank and auto-apply

- Import PDF / DOCX / TXT / Markdown / HTML / JSON resumes; per-module AI polish, whole-resume diagnosis with item-by-item fixes, revision history with undo.
- 29 A4 templates with favourites, default template and accent colours; preview and PDF share the same HTML.
- Question bank with community questions, predicted questions, AI answers, comments and sharing.
- Auto-apply on Boss Zhipin / Zhilian / 51job: live job search, per-platform tags, company blocking, AI or template greetings with preview, and an on-site application assistant that fills official career pages for you to confirm.

## Data and privacy

- Audio is transient: single-sentence files are deleted after a session is merged.
- Resumes, templates and imported text stay in the local `userData` directory.
- Transcripts and generation calls go only to the STT / LLM endpoints you configured.
- The profile sent to models has phone, email, WeChat and personal links removed; webhook URLs are shown as "configured" only.
- Platform logins live in Electron persistent partitions (`persist:job-sites-<site>`); the plugin never reads or uploads cookies.

## Permissions

`process`, `network`, local storage.

## Links

- Marketplace: https://ruodao.com/plugin-market

## License

MIT
