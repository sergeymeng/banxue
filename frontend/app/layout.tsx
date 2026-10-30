import type { Metadata } from 'next';
import 'tldraw/tldraw.css';
import './globals.css';
export const metadata: Metadata = { title: '伴学 · 本地 AI 私人教师', description: '有连续记忆的个人数学课堂。数据保存在本机。' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
