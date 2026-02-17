import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(215 16% 85%)',
        input: 'hsl(215 16% 85%)',
        ring: 'hsl(222 84% 60%)',
        background: 'hsl(0 0% 100%)',
        foreground: 'hsl(222 47% 11%)',
        primary: {
          DEFAULT: 'hsl(222 84% 56%)',
          foreground: 'hsl(210 40% 98%)'
        },
        secondary: {
          DEFAULT: 'hsl(210 40% 96%)',
          foreground: 'hsl(222 47% 11%)'
        },
        muted: {
          DEFAULT: 'hsl(210 40% 96%)',
          foreground: 'hsl(215 16% 47%)'
        }
      }
    }
  },
  plugins: []
};

export default config;
