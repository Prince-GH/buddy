# Buddy — Auto-start Live Voice Companion (No Recording)

Buddy requests microphone access on page load and analyses short live audio feature windows every 2 seconds. It does not use MediaRecorder, write audio files, provide playback/download controls, or use browser speech recognition. The microphone stream is used only for local acoustic feature analysis while the page is open.

## Run locally
Run `python -m http.server 8000` in this folder and open `http://localhost:8000/`. Allow microphone permission when prompted. If permission is denied, change the browser site permission and tap Buddy to retry.

## Phone and sharing
Deploy the folder to a static HTTPS host such as GitHub Pages. Open the HTTPS URL on the phone and allow microphone access. Share that URL with friends. A raw LAN HTTP address may not allow microphone access because microphone APIs generally require HTTPS or localhost.

## Privacy and limitations
No audio recording or audio file is created or saved by this app. Acoustic cues like loudness, pitch estimate, and spectral brightness drive the expressions. These are rough visual heuristics and cannot reliably determine a person's real emotional state. Microphone access must be allowed by the user; browsers may not grant it automatically without permission.
