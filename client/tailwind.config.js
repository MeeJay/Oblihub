/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          primary: 'rgb(var(--c-bg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--c-bg-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--c-bg-tertiary) / <alpha-value>)',
          hover: 'rgb(var(--c-bg-hover) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--c-border) / <alpha-value>)',
        },
        text: {
          primary: 'rgb(var(--c-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
          muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
        },
        status: {
          up: 'rgb(var(--c-status-up) / <alpha-value>)',
          'up-bg': 'rgb(var(--c-status-up-bg) / <alpha-value>)',
          down: 'rgb(var(--c-status-down) / <alpha-value>)',
          'down-bg': 'rgb(var(--c-status-down-bg) / <alpha-value>)',
          pending: 'rgb(var(--c-status-pending) / <alpha-value>)',
          'pending-bg': 'rgb(var(--c-status-pending-bg) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
