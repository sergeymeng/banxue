import { api, Turn } from './api';

export type Region = { x: number; y: number; width: number; height: number };
export type RegionSource = {
  kind: 'whiteboard_region' | 'upload' | 'fixture' | 'legacy_page';
  page_id?: string; snapshot_id?: string; revision?: number; element_ids?: string[]; author?: 'student'; region?: Region | null; label?: string;
};
// The board supplies the already-cropped PNG. Coordinates refer to that exact image.
export type RegionImage = { image: string; source: RegionSource; trigger?: 'idle' | 'explicit' };
export type ObservedStep = { id: string; order: number; text: string; expressions: string[]; region: Region; mark: 'active' | 'crossed_out' | 'unclear' };
export type Ambiguity = { id: string; step_id: string; region: Region; reason: string; alternatives: string[] };
export type Observation = {
  id: string; schema_version: 1; steps: ObservedStep[]; ambiguities: Ambiguity[]; notes: string;
  source: RegionSource & { sha256: string; width: number; height: number };
  provenance: { adapter: string; model: string; mode: string; coordinates: string };
  status: 'pending' | 'confirmed'; resolutions?: Record<string, string>; step_complete?: boolean; uncertainty: string; visible_text?: string;
};
export type ObservationRecord = { stale_reason?: string | null; image: string; observation: Observation; status: 'pending' | 'confirmed' | 'discarded'; reviewed?: Observation };
export function submitRegion(lessonId: string, region: RegionImage) {
  return api<Turn>(`/api/lessons/${lessonId}/observations`, { method: 'POST', body: JSON.stringify(region) });
}
export function readPng(file: Blob): Promise<string> {
  if (file.size > 2_999_000) return Promise.reject(new Error('PNG 请小于 3MB。'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败。'));
    reader.readAsDataURL(file);
  });
}

// Structural subset of whiteboard/types.ts; keeps this branch independent until integration.
export type StudentBoardExport = { image: string; region: Region; revision: number; elementIds: string[]; author: 'student' | 'teacher' | 'all' };
export type RegionBoardController = {
  exportRegion(options: { author: 'student'; region?: Region }): Promise<StudentBoardExport>;
  flush(): Promise<void>;
  getSnapshot(): { revision: number };
};
export function fromBoardExport(exported: StudentBoardExport): RegionImage {
  if (exported.author !== 'student' || !Number.isSafeInteger(exported.revision) || exported.revision < 0 || !exported.elementIds.length || new Set(exported.elementIds).size !== exported.elementIds.length) {
    throw new Error('需要当前学生笔迹的区域图片。');
  }
  return { image: exported.image, trigger: 'explicit', source: {
    kind: 'whiteboard_region', page_id: 'main', snapshot_id: `banxue-board:v1:${exported.revision}`,
    revision: exported.revision, element_ids: [...exported.elementIds], author: 'student', region: { ...exported.region },
  } };
}
export async function prepareStudentRegion(controller: RegionBoardController, region?: Region): Promise<RegionImage> {
  const exported = await controller.exportRegion({ author: 'student', region });
  await controller.flush();
  if (controller.getSnapshot().revision !== exported.revision) throw new Error('白板已变化，请重新读取这一步。');
  return fromBoardExport(exported);
}
export function staleBoardReason(observation: Observation, revision?: number): string | null {
  if (observation.source.kind !== 'whiteboard_region') return null;
  return revision === observation.source.revision ? null : '白板已变化或尚未同步，请重新读取这一步。';
}
