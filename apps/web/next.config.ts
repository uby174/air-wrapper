import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@ai-wrapper/shared', '@ai-wrapper/core']
};

export default nextConfig;
