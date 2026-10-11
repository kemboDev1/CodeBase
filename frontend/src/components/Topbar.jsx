import React from 'react';
import { Github, Menu, Plus, RefreshCw } from 'lucide-react';

const PAGE_HINTS = {
  Chat: 'Streaming chat, tool timeline va ruxsat so‘rovlari',
  Files: 'Workspace fayllarini ko‘rish, tahrirlash va saqlash',
  Terminal: 'Buyruqlarni xavfsiz, ruxsat bilan ishga tushirish',
  MCP: 'Model Context Protocol serverlarini boshqarish',
  Plugins: 'Lokal plaginlarni yoqish va kuzatish',
  Skills: 'Qayta ishlatiladigan yo‘riqnomalar (skills)',
  Memory: 'Uzoq muddatli eslatmalar va afzalliklar',
  Projects: 'Loyihalar, root papkalar va ko‘rsatmalar',
  Settings: 'Model, Ollama va workspace sozlamalari',
};

export default function Topbar({
  page,
  projectName,
  health,
  modelCount = 0,
  onRefresh,
  onNewChat,
  onToggleSidebar,
  sidebarCollapsed,
  busy,
}) {
  const connected = Boolean(health?.ollama?.connected);
  return (
    <header className="topbar">
      <div className="breadcrumb">
        {sidebarCollapsed ? (
          <button type="button" className="icon-btn topbar-menu" onClick={onToggleSidebar} title="Sidebarni ochish" aria-label="Sidebarni ochish">
            <Menu size={16} />
          </button>
        ) : null}
        <span className="muted">CodeBase</span>
        <span className="crumb-slash">/</span>
        <b>{page}</b>
        {page === 'Chat' && projectName ? (
          <>
            <span className="crumb-slash">/</span>
            <span className="crumb-project">{projectName}</span>
          </>
        ) : null}
        {PAGE_HINTS[page] ? <span className="crumb-hint">{PAGE_HINTS[page]}</span> : null}
      </div>
      <div className="topbar-actions">
        <button type="button" className="ghost-btn" onClick={onNewChat} disabled={busy} title="Yangi chat">
          <Plus size={14} /> <span>New chat</span>
        </button>
        <div className={`connection-pill ${connected ? 'connected' : ''}`} title={health?.ollama?.error || 'Ollama holati'}>
          <span className={`status-led ${connected ? 'online' : ''}`} />
          <span>{busy ? 'Agent ishlayapti' : connected ? `Local model online · ${modelCount}` : 'Model offline'}</span>
        </div>
        <button
          type="button"
          className="github-button"
          onClick={() => window.open('https://github.com/', '_blank', 'noopener,noreferrer')}
          title="GitHub"
        >
          <Github size={15} /> <span>GitHub</span>
        </button>
        <button type="button" className="icon-btn" onClick={onRefresh} title="Holatni yangilash" aria-label="Holatni yangilash">
          <RefreshCw size={15} />
        </button>
      </div>
    </header>
  );
}
