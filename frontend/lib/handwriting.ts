import { api, Turn } from './api';

export type Region = { x: number; y: number; width: number; height: number };
export type RegionSource = {
  kind: 'whiteboard_region' | 'upload' | 'fixture' | 'legacy_page';
  page_id?: string; snapshot_id?: string; region?: Region | null; label?: string;
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
export type ObservationRecord = { image: string; observation: Observation; status: 'pending' | 'confirmed' | 'discarded'; reviewed?: Observation };
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
