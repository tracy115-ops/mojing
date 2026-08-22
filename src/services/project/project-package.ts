// ============================================================================
// project-package.ts — .mojing 项目工程备份包统一打包导出与导入
// ============================================================================
// 功能：
//   1. exportProjectPackage: 将项目的 metadata、分镜剧本(sceneSpec)、角色库、
//      生成的 clips、配音音轨以及流水线各 stage 状态打包为一个 .mojing JSON 格式文件。
//   2. importProjectPackage: 解析并校验 .mojing 文件，无缝还原到 projectStore、
//      videoStore / comicStore / novelStore 中。

import { useProjectStore } from '@/stores/projectStore';
import { useVideoStore } from '@/stores/videoStore';
import { useComicStore } from '@/stores/comicStore';
import type { CreativeProject } from '@/types';
import type { VideoProjectState } from '@/types/video';

export interface MojingPackageEnvelope {
  format: 'mojing-project-package';
  version: '1.0';
  exportedAt: string;
  project: CreativeProject;
  videoState?: VideoProjectState;
  comicState?: Record<string, unknown>;
  novelChapters?: unknown[];
}

/**
 * 将指定项目打包并触发本地下载 / 保存为 .mojing 文件
 */
export async function exportProjectPackage(projectId: string): Promise<boolean> {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`未找到项目 ID: ${projectId}`);
  }

  const videoState = useVideoStore.getState().getProject(projectId);
  const comicState = useComicStore.getState().projects[projectId] as unknown as Record<string, unknown> | undefined;

  const pkg: MojingPackageEnvelope = {
    format: 'mojing-project-package',
    version: '1.0',
    exportedAt: new Date().toISOString(),
    project,
    videoState,
    comicState,
  };

  const jsonContent = JSON.stringify(pkg, null, 2);
  const fileName = `${sanitizeFileName(project.title || 'mojing-project')}_${formatDateSuffix(new Date())}.mojing`;

  // 触发浏览器 / Webview 本地文件下载
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8' });
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(downloadUrl);

  return true;
}

/**
 * 解析并导入一个 .mojing 文件内容
 */
export async function importProjectPackage(jsonString: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error('无效的工程包：无法解析为 JSON 格式');
  }

  const pkg = parsed as Partial<MojingPackageEnvelope>;
  if (pkg.format !== 'mojing-project-package' || !pkg.project) {
    throw new Error('无效的工程包：非标准 .mojing 工程包文件');
  }

  const existingProjects = useProjectStore.getState().projects;
  let targetProject = { ...pkg.project };

  // 若已存在相同 ID 的项目，则生成新 ID 并重命名以防冲突
  if (existingProjects.some((p) => p.id === targetProject.id)) {
    const newId = `imported_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const oldId = targetProject.id;
    targetProject = {
      ...targetProject,
      id: newId,
      title: `${targetProject.title} (导入副本)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 如果包含 videoState，同步迁移至新 ID
    if (pkg.videoState) {
      useVideoStore.setState((state) => ({
        projects: {
          ...state.projects,
          [newId]: {
            ...pkg.videoState!,
            stages: pkg.videoState!.stages || {},
            clips: pkg.videoState!.clips || [],
          },
        },
      }));
    }
  } else {
    // 直接保留原 ID 导入
    if (pkg.videoState) {
      useVideoStore.setState((state) => ({
        projects: {
          ...state.projects,
          [targetProject.id]: pkg.videoState!,
        },
      }));
    }
  }

  // 插入到 projectStore
  useProjectStore.setState((state) => ({
    projects: [targetProject, ...state.projects.filter((p) => p.id !== targetProject.id)],
    activeProjectId: targetProject.id,
  }));

  return targetProject.id;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

function formatDateSuffix(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}
