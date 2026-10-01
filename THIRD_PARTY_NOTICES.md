# Third-party notices

Media Converter's own source code is released under the MIT License (see `LICENSE`).
The application packages and installers also contain the third-party software listed below, each under its own license.
Versions are those used for the 0.1.0 builds; `npm ls --omit=dev` and `resources/bin/<platform>-<arch>/BUILDINFO.json` show the exact versions of any given build.

---

## FFmpeg (bundled executables)

| | |
|---|---|
| Component | `ffmpeg` and `ffprobe` command-line programs and their shared libraries (`avcodec`, `avformat`, `avfilter`, `avdevice`, `avutil`, `swscale`, `swresample`) |
| Windows x64 build | FFmpeg `n8.1.2-50-g1a748fe2cd` (release/8.1 branch), **GPL "shared" variant** from BtbN FFmpeg-Builds, release [`autobuild-2026-08-31-13-27`](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-08-31-13-27), file `ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-shared-8.1.zip` (SHA-256 `0a41f31caff48e3035b48f09f5d840bd8d1863008240fc43e457f15e589cf5b3`) |
| macOS builds | FFmpeg 9.0.2 static GPL builds by Martin Riedl, <https://ffmpeg.martin-riedl.de/> (build scripts: <https://git.martin-riedl.de/ffmpeg/build-script>) |
| Linux builds | FFmpeg static GPL builds by John Van Sickle, <https://johnvansickle.com/ffmpeg/> (sources: <https://johnvansickle.com/ffmpeg/release-source/>) |
| License | **GNU General Public License v3.0 or later** — the builds are configured with `--enable-gpl --enable-version3`, so the combined FFmpeg binaries are distributed under GPLv3. The full license text is shipped next to the binaries as `bin/LICENSE-ffmpeg.txt` (Windows) and at <https://www.gnu.org/licenses/gpl-3.0.html>. |
| Source code | FFmpeg: <https://github.com/FFmpeg/FFmpeg/commit/1a748fe2cd> (also <https://ffmpeg.org/download.html>). Build scripts and the exact versions of every external library: <https://github.com/BtbN/FFmpeg-Builds> at the tag above. |
| Copyright | © 2000–2026 the FFmpeg developers, and the authors of the external libraries listed below |

**How Media Converter uses FFmpeg.** FFmpeg is *not* linked into Media Converter. The app ships `ffmpeg` / `ffprobe` as separate, unmodified executables (in the `bin` folder of the installation's `resources` directory) and runs them as independent processes, passing arguments on the command line. You may replace them with any other FFmpeg build: *Settings → custom ffmpeg path*.

**External libraries in the Windows GPL build** (as reported by `ffmpeg -buildconf`), statically linked into the FFmpeg DLLs. Among them: x264 (GPL-2.0-or-later), x265 (GPL-2.0-or-later), Xvid (GPL-2.0-or-later), xavs2 / davs2 (GPL-2.0-or-later), libvidstab (GPL-2.0-or-later), frei0r (GPL-2.0-or-later), rubberband (GPL-2.0-or-later), SVT-AV1 (BSD-3-Clause-Clear + AOMedia patent license), libaom (BSD-2-Clause + AOMedia patent license), dav1d (BSD-2-Clause), rav1e (BSD-2-Clause), libvpx (BSD-3-Clause), libwebp (BSD-3-Clause), libjxl (BSD-3-Clause), OpenH264 (BSD-2-Clause), Kvazaar (BSD-3-Clause), VVenC (BSD-3-Clause-Clear), uavs3d (BSD-3-Clause), LAME (LGPL-2.0-or-later), Opus (BSD-3-Clause), Vorbis / Theora (BSD-3-Clause), TwoLAME (LGPL-2.1-or-later), opencore-amr (Apache-2.0), libsoxr (LGPL-2.1-or-later), libopenmpt (BSD-3-Clause), libgme (LGPL-2.1-or-later), Chromaprint (LGPL-2.1-or-later), libass (ISC), FreeType (FreeType License), Fontconfig (MIT-style), HarfBuzz (MIT), FriBidi (LGPL-2.1-or-later), libxml2 (MIT), zimg (WTFPL), libplacebo (LGPL-2.1-or-later), shaderc (Apache-2.0), Vulkan loader/headers (Apache-2.0), libvmaf (BSD-2-Clause-Patent), OpenJPEG (BSD-2-Clause), libbluray / libdvdread / libdvdnav (LGPL-2.1-or-later), libzvbi (LGPL-2.0-or-later), libaribb24 (LGPL-3.0), libaribcaption (MIT), SRT (MPL-2.0), RIST (BSD-2-Clause), libssh (LGPL-2.1), ZeroMQ (MPL-2.0), Snappy (BSD-3-Clause), GMP (LGPL-3.0-or-later), xz/liblzma (0BSD / public domain), zlib (zlib), SDL2 (zlib), OpenAL Soft (LGPL-2.0-or-later), LV2 (ISC), LCEVC decoder (BSD-3-Clause-Clear), OpenAPV (BSD-3-Clause), NVIDIA codec headers (MIT), Intel oneVPL / libvpl dispatcher (MIT), AMD AMF headers (MIT), OpenCL headers (Apache-2.0). Hardware encoders (NVENC, Quick Sync, AMF, VA-API) use the GPU vendor's driver installed on the user's computer; those drivers are not distributed with Media Converter. License identifiers in this list are given for orientation; the authoritative terms are the license files in each project's source.

**Corresponding source (GPLv3 §6).** The links above point to the exact FFmpeg commit and the build recipe (which pins every library version). Maintainers publishing a release should also attach the FFmpeg source archive for the bundled version (and keep it available alongside the binaries) so the corresponding source stays available even if upstream builds are pruned.

---

## sharp

- Version 0.35.5 — <https://github.com/lovell/sharp>
- License: **Apache-2.0** — Copyright 2013 Lovell Fuller and others
- Runtime dependencies: `@img/colour` (MIT), `detect-libc` (Apache-2.0, Lovell Fuller), `semver` (ISC, GitHub Inc. and contributors)

## libvips and the libraries bundled with sharp's prebuilt binaries

sharp's prebuilt packages (`@img/sharp-<platform>` / `@img/sharp-libvips-<platform>`, built by <https://github.com/lovell/sharp-libvips>) contain libvips 8.18.7 and its dependencies as **separate shared libraries** (e.g. `libvips-42.dll`, `libvips-cpp-8.18.7.dll` on Windows) that are loaded at run time and stored unpacked in `resources/app.asar.unpacked/node_modules/@img/`, so they can be replaced by the user as required by the LGPL.

| Library | Version | License |
|---|---|---|
| libvips | 8.18.7 | LGPL-3.0-or-later — <https://github.com/libvips/libvips> |
| aom | 3.15.1 | BSD-2-Clause + AOMedia Patent License |
| libarchive | 3.8.9 | BSD-2-Clause |
| cairo | 1.18.6 | LGPL-2.1-only or MPL-1.1 |
| cgif | 0.5.4 | MIT |
| libexif | 0.6.26 | LGPL-2.1-or-later |
| expat | 2.8.5 | MIT |
| libffi | 3.8.0 | MIT |
| fontconfig | 2.18.3 | MIT-style (fontconfig license) |
| FreeType | 2.14.3 | FreeType License (FTL) |
| FriBidi | 1.0.17 | LGPL-2.1-or-later |
| GLib | 2.90.0 | LGPL-2.1-or-later |
| HarfBuzz | 14.5.0 | MIT |
| libheif | 1.23.5 | LGPL-3.0-or-later |
| Highway | 1.4.0 | Apache-2.0 or BSD-3-Clause |
| libimagequant | 2.4.1 | BSD-2-Clause |
| Little CMS (lcms2) | 2.19.1 | MIT |
| mozjpeg | 0826579 | IJG + BSD-3-Clause + zlib |
| Pango | 1.58.2 | LGPL-2.1-or-later |
| pixman | 0.46.4 | MIT |
| libpng | 1.6.58 | libpng License v2 |
| proxy-libintl | 0.5 | LGPL-2.1-or-later |
| librsvg | 2.63.2 | LGPL-2.1-or-later |
| libtiff | 4.7.2 | libtiff License (MIT-style) |
| libultrahdr | 2.0.2 | Apache-2.0 |
| libwebp | 1.6.0 | BSD-3-Clause |
| libxml2 | 2.15.4 | MIT |
| zlib-ng | 2.3.3 | zlib |

Source code for each library is linked from <https://github.com/lovell/sharp-libvips> (the build scripts pin every version and download URL).

---

## Electron, Chromium and Node.js

- Electron 44.5.1 — **MIT**, Copyright (c) Electron contributors, Copyright (c) 2013–2020 GitHub Inc. — <https://github.com/electron/electron>
- Electron contains Chromium (BSD-3-Clause, The Chromium Authors, plus many third-party components) and Node.js (MIT, Node.js contributors, plus bundled components). Their complete license texts are shipped with every build as `LICENSE.electron.txt` and `LICENSES.chromium.html` in the installation folder.

## JavaScript libraries bundled into the app

| Package | Version | License | Copyright |
|---|---|---|---|
| react, react-dom | 19.3.0 | MIT | Meta Platforms, Inc. and affiliates |
| zustand | 5.0.15 | MIT | Paul Henschel |
| lucide-react | 1.49.0 | ISC | Lucide Contributors (icons derived from Feather, MIT, Cole Bemis) |
| chokidar | 5.0.0 | MIT | Paul Miller, Elan Shanker |
| readdirp | 5.1.1 | MIT | Thorsten Lorenz, Paul Miller |

Build-time tools (TypeScript, Vite, electron-vite, electron-builder, Vitest, Playwright) are not shipped in the application.

---

## App icon

The Media Converter icon (`resources/icon.svg`) is original artwork made for this project and is covered by the project's MIT License.

---

### License texts

- MIT: <https://opensource.org/license/mit>
- ISC: <https://opensource.org/license/isc-license-txt>
- Apache-2.0: <https://www.apache.org/licenses/LICENSE-2.0>
- BSD-2-Clause / BSD-3-Clause: <https://opensource.org/license/bsd-3-clause>
- GPL-3.0: <https://www.gnu.org/licenses/gpl-3.0.html> · GPL-2.0: <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>
- LGPL-3.0: <https://www.gnu.org/licenses/lgpl-3.0.html> · LGPL-2.1: <https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>
- MPL-2.0: <https://www.mozilla.org/MPL/2.0/>
