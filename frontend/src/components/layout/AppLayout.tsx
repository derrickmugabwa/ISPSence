import ActionErrorNotice from '../common/ActionErrorNotice';
import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import SecurityBanners from '../SecurityBanners';
import { useAccessRefresh } from '../../hooks/useAccessRefresh';

export default function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const assistantPage = useLocation().pathname === '/assistant';
  useAccessRefresh();

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar mobileOpen={sidebarOpen} onMobileClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar onMenuClick={() => setSidebarOpen((o) => !o)} />
        <SecurityBanners />
        <main className={assistantPage ? 'flex flex-1 flex-col min-h-0 overflow-hidden' : 'flex-1 overflow-auto'} style={{ padding: assistantPage ? 0 : '22px 28px' }}>
          <Outlet />
          <ActionErrorNotice />
        </main>
      </div>
    </div>
  );
}
