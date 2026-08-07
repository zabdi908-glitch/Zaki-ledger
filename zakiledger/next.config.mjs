/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: process.cwd(),
  compress: true,
  productionBrowserSourceMaps: false,
  poweredByHeader: false,
};
export default nextConfig;
