export const APP_VERSION = 'v0.54.0 Beta';

// ISPSense guides ship in the same image as the app, including offline installs.
export function docsUrl(path = ''): string {
  const [pathname, hash] = path.split('#');
  const slug = pathname.replace(/^\/+|\/+$/g, '');
  const guide = slug === 'adoption' ? 'router-onboarding' : slug;
  return `/docs${guide ? `/${guide}` : ''}${hash ? `#${hash}` : ''}`;
}
