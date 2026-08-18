/** True in Vite production builds (PWA dist or native VITE_NATIVE_BUILD). */
export function isProductionBuild(): boolean {
  return import.meta.env.PROD;
}
