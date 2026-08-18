// ============================================================================
// Export Service — Novel export to Markdown / HTML / TXT
// Uses Tauri dialog + fs plugins for file saving
// ============================================================================

import type { NovelChapter } from '@/types';

export type ExportFormat = 'markdown' | 'html' | 'txt';

export interface ExportOptions {
  title: string;
  author?: string;
  chapters: NovelChapter[];
  format: ExportFormat;
  chapterRange?: [number, number]; // inclusive range of chapter indices
}

export interface ExportResult {
  success: boolean;
  path?: string;
  error?: string;
  wordCount: number;
  chapterCount: number;
}

export class ExportService {
  /**
   * Export novel to the specified format and save to file.
   */
  static async exportToFile(options: ExportOptions): Promise<ExportResult> {
    const { format, title, chapters } = options;

    // Filter chapters by range if specified
    let filteredChapters = chapters.filter((c) => c.content);
    if (options.chapterRange) {
      const [start, end] = options.chapterRange;
      filteredChapters = filteredChapters.filter((c) => c.order >= start && c.order <= end);
    }

    if (filteredChapters.length === 0) {
      return { success: false, error: 'No chapters with content to export', wordCount: 0, chapterCount: 0 };
    }

    const totalWords = filteredChapters.reduce((s, c) => s + (c.wordCount || c.content.length), 0);

    let content: string;
    let extension: string;
    let mimeType: string;

    switch (format) {
      case 'markdown':
        content = ExportService.toMarkdown(options.title, options.author, filteredChapters);
        extension = 'md';
        mimeType = 'text/markdown';
        break;
      case 'html':
        content = ExportService.toHTML(options.title, options.author, filteredChapters);
        extension = 'html';
        mimeType = 'text/html';
        break;
      case 'txt':
        content = ExportService.toTXT(options.title, options.author, filteredChapters);
        extension = 'txt';
        mimeType = 'text/plain';
        break;
    }

    // Save file — use Tauri's native save dialog + Rust write command
    let savedPath: string | undefined;
    try {
      // Step 1: Open native save dialog (non-blocking for webview)
      const { save } = await import('@tauri-apps/plugin-dialog');
      const filePath = await save({
        defaultPath: `${title}.${extension}`,
        filters: [{ name: format.toUpperCase(), extensions: [extension] }],
      });

      // 重新激活窗口焦点
      try {
        window.focus();
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await (getCurrentWindow() as any).setFocus?.();
      } catch {}

      if (!filePath) {
        return { success: false, error: 'Export cancelled', wordCount: totalWords, chapterCount: filteredChapters.length };
      }

      // Step 2: Write file via Rust command (fast, no webview involvement)
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('write_export_file', { path: filePath, content });
      savedPath = filePath;
    } catch {
      // Tauri not available or dialog cancelled — fallback to clipboard
      try {
        await navigator.clipboard.writeText(content);
        return {
          success: true,
          wordCount: totalWords,
          chapterCount: filteredChapters.length,
        };
      } catch {
        return { success: false, error: 'Export failed', wordCount: totalWords, chapterCount: filteredChapters.length };
      }
    }

    return { success: true, path: savedPath, wordCount: totalWords, chapterCount: filteredChapters.length };
  }

  /**
   * Convert to Markdown format.
   */
  static toMarkdown(title: string, author: string | undefined, chapters: NovelChapter[]): string {
    const lines: string[] = [];

    lines.push(`# ${title}`);
    if (author) lines.push(`\n**作者**: ${author}`);
    lines.push(`\n---\n`);

    // Table of contents
    lines.push('## 目录\n');
    for (const ch of chapters) {
      const chTitle = ch.title || `第${ch.order + 1}章`;
      lines.push(`- [${chTitle}](#${sanitizeAnchor(chTitle)})`);
    }
    lines.push('\n---\n');

    // Chapters
    for (const ch of chapters) {
      const chTitle = ch.title || `第${ch.order + 1}章`;
      lines.push(`## ${chTitle}\n`);
      lines.push(ch.content);
      lines.push('\n');
    }

    return lines.join('\n');
  }

  /**
   * Convert to HTML format with styled output.
   */
  static toHTML(title: string, author: string | undefined, chapters: NovelChapter[]): string {
    const tocItems = chapters.map((ch) => {
      const chTitle = ch.title || `第${ch.order + 1}章`;
      return `<li><a href="#ch${ch.order}">${escapeHtml(chTitle)}</a></li>`;
    }).join('\n');

    const chapterHTML = chapters.map((ch) => {
      const chTitle = ch.title || `第${ch.order + 1}章`;
      const paragraphs = ch.content
        .split(/\n+/)
        .filter((p) => p.trim())
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join('\n');
      return `<h2 id="ch${ch.order}">${escapeHtml(chTitle)}</h2>\n${paragraphs}`;
    }).join('\n\n');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: 'Noto Serif SC', 'Source Han Serif CN', 'SimSun', serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.8; color: #333; }
    h1 { text-align: center; font-size: 2rem; margin-bottom: 0.5rem; }
    h2 { page-break-before: always; border-bottom: 1px solid #ddd; padding-bottom: 0.5rem; margin-top: 3rem; }
    .author { text-align: center; color: #666; margin-bottom: 2rem; }
    .toc { background: #f9f9f9; padding: 1rem 2rem; border-radius: 8px; margin: 2rem 0; }
    .toc ul { list-style: none; padding: 0; }
    .toc li { padding: 0.3rem 0; }
    .toc a { color: #3b82f6; text-decoration: none; }
    .toc a:hover { text-decoration: underline; }
    p { text-indent: 2em; margin: 0.8rem 0; }
    @media print { h2 { page-break-before: always; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${author ? `<p class="author">${escapeHtml(author)}</p>` : ''}
  <div class="toc">
    <h3>目录</h3>
    <ul>${tocItems}</ul>
  </div>
  ${chapterHTML}
</body>
</html>`;
  }

  /**
   * Convert to plain text format.
   */
  static toTXT(title: string, author: string | undefined, chapters: NovelChapter[]): string {
    const lines: string[] = [];

    lines.push(title);
    lines.push('='.repeat(title.length * 2));
    if (author) lines.push(`作者: ${author}`);
    lines.push('');

    for (const ch of chapters) {
      const chTitle = ch.title || `第${ch.order + 1}章`;
      lines.push(chTitle);
      lines.push('-'.repeat(chTitle.length * 2));
      lines.push(ch.content);
      lines.push('');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Blob-based file download (fallback for browser/dev mode).
   */
  static blobDownload(content: string, title: string, extension: string, mimeType: string): void {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

// --- Helpers ---

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeAnchor(text: string): string {
  return encodeURIComponent(text.replace(/\s+/g, '-').toLowerCase());
}
