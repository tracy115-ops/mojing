# Third-party notices

## Open AI Canvas

Source: https://github.com/ddcat-ai/open-ai-canvas

Reference commit: `a0bdc23f450262e3a00e94019ed703fa42ba5e60`

The shot direction rules in `src/services/video/core/shot-motion-prompt.ts` are
adapted from `backend/internal/production/segment_prompt.go`. The storyboard
workflow also draws on the project's storyboard and Agnes provider design.
The native video studio, node canvas, Three.js previs workspace, commerce,
assets, tasks, creative methods and Eagle integration draw on the corresponding
upstream page and workflow designs, reimplemented for this application's
existing Tauri, React and provider architecture. Upstream backend services,
third-party editor runtimes and separately licensed skill resources are not bundled.
See `docs/video-generation/16-open-ai-canvas-sync.md` and
`docs/video-generation/17-video-studio-redesign.md` for the feature-by-feature scope.

```text
MIT License

Copyright (c) 2026 ddcat and Open AI Canvas contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
