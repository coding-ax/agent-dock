import colors from 'tailwindcss/colors';

const v = name => `rgb(var(--${name}) / <alpha-value>)`;
const scale = (name, shades) => Object.fromEntries(shades.map(shade => [shade, v(`${name}-${shade}`)]));
const tinted = name => ({ ...colors[name], ...scale(name, [50, 100, 200]) });

/**
 * 颜色全部走 CSS 变量（见 index.css 的 :root 与 [data-theme="dark"]）。
 * 业务代码里到处是 zinc-* / white / red-50 这类 class，把这些色阶重映射成变量，
 * 暗色模式和配色调整就只改一处，不用逐个替换 class。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        white: v('surface'),
        zinc: scale('zinc', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        red: tinted('red'), amber: tinted('amber'), orange: tinted('orange'), emerald: tinted('emerald'), blue: tinted('blue'), sky: tinted('sky'),
        accent: v('accent'), canvas: v('bg'), rail: v('rail'), link: v('link'), ink: v('ink')
      },
      fontFamily: { sans: ['"Fira Code"', '-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', '"Segoe UI"', '"Helvetica Neue"', '"Microsoft YaHei"', 'sans-serif'], mono: ['"Fira Code"', 'SFMono-Regular', 'ui-monospace', 'Menlo', 'monospace'] }
    }
  },
  plugins: []
};
