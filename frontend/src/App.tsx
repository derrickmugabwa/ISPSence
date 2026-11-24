import PortalCheckoutPage from './pages/PortalCheckoutPage';
import PortalPaymentDemoPage from './pages/PortalPaymentDemoPage';
import PublicPortalPage from './pages/PublicPortalPage';
import PortalsPage from './pages/PortalsPage';
import PortalEditorPage from './pages/PortalEditorPage';
import RadiusDiagnosticsPage from './pages/RadiusDiagnosticsPage';
import AccessAlertsPage from './pages/AccessAlertsPage';
import React from 'react';
const AiChatPage=React.lazy(()=>import('./pages/AiChatPage'));
const DocsPage=React.lazy(()=>import('./pages/DocsPage'));
const LandingPage=React.lazy(()=>import('./pages/LandingPage'));
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import SitesPage from './pages/SitesPage';
import SiteLanding from './components/SiteLanding';
import DevicesPage from './pages/DevicesPage';
import DeviceDetailPage from './pages/DeviceDetailPage';
import ClientsPage from './pages/ClientsPage';
import EventsPage from './pages/EventsPage';
import TopologyPage from './pages/TopologyPage';
import BackupsPage from './pages/BackupsPage';
import FirmwarePage from './pages/FirmwarePage';
import FirmwareHistoryPage from './pages/FirmwareHistoryPage';
import FirmwareMirrorPage from './pages/FirmwareMirrorPage';
import UserManagerPage from './pages/UserManagerPage';
import CredentialsPage from './pages/CredentialsPage';
import CommandsPage from './pages/CommandsPage';
import TemplatesPage from './pages/TemplatesPage';
import SettingsPage from './pages/SettingsPage';
import OidcCallbackPage from './pages/OidcCallbackPage';
import WirelessPage from './pages/WirelessPage';
import WirelessSettingsPage from './pages/WirelessSettingsPage';
import GuestWifiPage from './pages/GuestWifiPage';
import PackagesPage from './pages/PackagesPage';
import CustomersPage from './pages/CustomersPage';
import PaymentsPage from './pages/PaymentsPage';
import SubscriptionsPage from './pages/SubscriptionsPage';
import CustomerSessionsPage from './pages/CustomerSessionsPage';
import CustomerProfilePage from './pages/CustomerProfilePage';
import ClientDetailPage from './pages/ClientDetailPage';
import NetworkServicesOverviewPage from './pages/NetworkServicesOverviewPage';
import NetworkServicesDHCPPage from './pages/NetworkServicesDHCPPage';
import NetworkServicesDNSPage from './pages/NetworkServicesDNSPage';
import NetworkServicesNTPPage from './pages/NetworkServicesNTPPage';
import NetworkServicesWireGuardPage from './pages/NetworkServicesWireGuardPage';
import NetworkServicesSyslogPage from './pages/NetworkServicesSyslogPage';
import NetworkServicesNetflowPage from './pages/NetworkServicesNetflowPage';
import NetworkServicesDiscoveryPage from './pages/NetworkServicesDiscoveryPage';
import TrafficAnalyticsPage from './pages/TrafficAnalyticsPage';
import SecurityPage from './pages/SecurityPage';
import ChangePasswordPage from './pages/ChangePasswordPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const mustChange = useAuthStore((s) => !!s.user?.must_change_password);
  if (!token) return <Navigate to="/login" replace />;
  if (mustChange) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/**
 * Remount a detail page when its route parameter changes (outside review U2).
 * React Router reuses the component when only the id changes, so a form or a
 * Change Guard "Apply anyway" dialog opened for device A stayed open on device
 * B, and saving it wrote A's settings to B.
 */
function KeyedByParam({ param, children }: { param: string; children: React.ReactElement }) {
  const params = useParams();
  return <React.Fragment key={new Map(Object.entries(params)).get(param) ?? ''}>{children}</React.Fragment>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<React.Suspense fallback={null}><LandingPage /></React.Suspense>} />
        <Route path="/docs/*" element={<React.Suspense fallback={<div role="status" className="p-8">Loading documentation…</div>}><DocsPage /></React.Suspense>} />
        <Route path="/portal-demo" element={<PortalPaymentDemoPage />} />
        <Route path="/portal/:slug/demo" element={<PortalPaymentDemoPage />} />
        <Route path="/portal/:slug/checkout/:packageId" element={<PortalCheckoutPage />} />
        <Route path="/portal/:slug" element={<PublicPortalPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route path="/auth/callback" element={<OidcCallbackPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="workspace" element={<SiteLanding />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="assistant" element={<React.Suspense fallback={<div role="status">Loading assistant...</div>}><AiChatPage /></React.Suspense>} />
          <Route path="billing/packages" element={<PackagesPage />} />
          <Route path="billing/customers" element={<CustomersPage />} />
          <Route path="billing/customers/:id" element={<KeyedByParam param="id"><CustomerProfilePage /></KeyedByParam>} />
          <Route path="billing/payments" element={<PaymentsPage />} />
          <Route path="billing/subscriptions" element={<SubscriptionsPage key="subscriptions" />} />
          <Route path="billing/access-accounts" element={<SubscriptionsPage key="accounts" accounts />} />
          <Route path="billing/portals" element={<PortalsPage />} />
          <Route path="billing/portals/:id" element={<KeyedByParam param="id"><PortalEditorPage /></KeyedByParam>} />
          <Route path="billing/radius" element={<RadiusDiagnosticsPage />} />
          <Route path="billing/alerts" element={<AccessAlertsPage />} />
          <Route path="billing/sessions" element={<CustomerSessionsPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="devices/:id" element={<KeyedByParam param="id"><DeviceDetailPage /></KeyedByParam>} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:mac" element={<KeyedByParam param="mac"><ClientDetailPage /></KeyedByParam>} />
          <Route path="events" element={<EventsPage />} />
          <Route path="topology" element={<TopologyPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="firmware" element={<FirmwarePage />} />
          <Route path="firmware/history" element={<FirmwareHistoryPage />} />
          <Route path="firmware/mirror" element={<FirmwareMirrorPage />} />
          <Route path="credentials" element={<CredentialsPage />} />
          <Route path="commands" element={<CommandsPage />} />
          <Route path="templates" element={<TemplatesPage />} />
          <Route path="sites" element={<SitesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {/* Legacy routes — consolidated in the v0.16.4 UI reorganization */}
          <Route path="switches" element={<Navigate to="/devices?type=SW" replace />} />
          <Route path="switches/settings" element={<Navigate to="/network-services/discovery" replace />} />
          <Route path="routers" element={<Navigate to="/devices?type=RTR" replace />} />
          <Route path="routers/settings" element={<Navigate to="/network-services/discovery" replace />} />
          <Route path="wireless/clients" element={<Navigate to="/clients?type=wireless" replace />} />
          <Route path="wireless" element={<WirelessPage />} />
          <Route path="wireless/settings" element={<WirelessSettingsPage />} />
          <Route path="wireless/guest" element={<GuestWifiPage />} />
          <Route path="network-services" element={<NetworkServicesOverviewPage />} />
          <Route path="user-manager" element={<UserManagerPage />} />
          <Route path="network-services/dhcp" element={<NetworkServicesDHCPPage />} />
          <Route path="network-services/dns" element={<NetworkServicesDNSPage />} />
          <Route path="network-services/ntp" element={<NetworkServicesNTPPage />} />
          <Route path="network-services/wireguard" element={<NetworkServicesWireGuardPage />} />
          <Route path="network-services/syslog" element={<NetworkServicesSyslogPage />} />
          <Route path="network-services/netflow" element={<NetworkServicesNetflowPage />} />
          <Route path="network-services/discovery" element={<NetworkServicesDiscoveryPage />} />
          <Route path="traffic" element={<TrafficAnalyticsPage />} />
          <Route path="security" element={<SecurityPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
