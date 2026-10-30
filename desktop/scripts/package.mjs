import { packager } from '@electron/packager';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const apps = await packager({ dir: path.join(root, 'desktop'), out: path.join(root, 'dist'), name: '伴学', executableName: 'Banxue', appBundleId: 'org.localtutor.banxue', appVersion: '0.3.0', platform: process.platform, arch: process.arch, overwrite: true, asar: true,
  extraResource: [path.join(root, 'build/desktop-resources/tutor-engine'), path.join(root, 'build/desktop-resources/web'), path.join(root, 'docs/DEPENDENCIES.md'), path.join(root, 'docs/licenses')],
  ignore: [/^\/tests/, /^\/scripts/, /^\/package-lock\.json$/],
  extendInfo: { NSMicrophoneUsageDescription: '伴学使用麦克风进行语音课堂，语音将发送到你配置的千问云服务。' },
  icon: path.join(root, 'desktop/icon.icns'),
});
for (const dir of apps) console.log(dir);
