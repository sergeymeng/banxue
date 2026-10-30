export type VoiceSettings = { enabled: boolean; region: 'beijing' | 'singapore'; api_key: string | null; has_key?: boolean; workspace: string; llm_model: string; asr_model: string; tts_model: string; voice: string; input_cny: number | null; output_cny: number | null; asr_cny_second: number | null; tts_cny_10k: number | null; cny_to_gbp: number | null };
export type ModelSettings = { base_url: string; model: string; api_key: string | null; has_key?: boolean; input_gbp: number | null; output_gbp: number | null };
export type DesktopSettings = { voice: VoiceSettings; mode: 'demo' | 'live'; token_field: 'max_tokens' | 'max_completion_tokens'; budgets: { request: number; session: number; day: number }; roles: Record<'fast' | 'reasoning' | 'vision', ModelSettings> };
declare global {
  interface Window {
    desktop?: {
      isDesktop: boolean;
      getSettings: () => Promise<DesktopSettings>;
      saveSettings: (settings: DesktopSettings) => Promise<{ saved: boolean }>;
      exportTeacher: (teacherId: string) => Promise<{ saved: boolean }>;
      openDataFolder: () => Promise<void>;
      onCommand: (callback: (command: string) => void) => () => void;
    };
  }
}
