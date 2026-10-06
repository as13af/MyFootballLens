# Third-party notices

MyFootballLens's own code is under the [MIT License](LICENSE). Its name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md).
The components below are included or used under their own licences, which still apply to them.

## Bundled fonts (SIL Open Font License 1.1)

| Font | Files | Copyright | Licence text |
|---|---|---|---|
| Inter | `static/fonts/Inter-var-*.woff2`, `app/assets/fonts/Inter-600.ttf` | The Inter Project Authors (https://github.com/rsms/inter) | `static/fonts/OFL-Inter.txt` |
| Hubot Sans | `static/fonts/HubotSans-var-*.woff2` | The Hubot Sans Project Authors (https://github.com/github/hubot-sans), Reserved Font Name "Hubot" | `static/fonts/OFL-HubotSans.txt` |
| JetBrains Mono | `static/fonts/JetBrainsMono-*.woff2` | The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | `static/fonts/OFL-JetBrainsMono.txt` |

The fonts are unmodified, apart from character-set subsetting as distributed by Google Fonts.
The OFL allows them to be bundled with software; the fonts themselves stay under the OFL, not the MIT License.

## Installed at setup (not included in this repository)

`start.bat` installs these Python packages from PyPI into a local `.venv`:

- **FastAPI**: MIT License.
- **Uvicorn**: BSD 3-Clause License.
- Their dependencies, including Starlette (BSD 3-Clause), Pydantic (MIT) and AnyIO (MIT).

## Required separately (not included)

- **FFmpeg / FFprobe** (LGPL/GPL, https://ffmpeg.org) must be installed by the user and available on PATH. MyFootballLens only calls it as an external program.

## Trademarks

"Sportscode" is a trademark of its respective owner.
It is mentioned only to describe compatibility with its XML timeline file format.
MyFootballLens is not affiliated with, sponsored by or endorsed by any of the companies whose products are mentioned.
