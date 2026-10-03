import { readFile, writeFile } from 'node:fs/promises';

// Inline the two small stylesheets to avoid first-paint network round trips.
const root = new URL('../../', import.meta.url);
const css = await Promise.all(['site-fonts.css', 'site.min.css'].map(name => readFile(new URL(name, root), 'utf8')));
const styles = `<style data-public-styles>\n${css.join('\n')}\n</style>`;
for (const name of ['index.html', 'neuron.html']) {
  const file = new URL(name, root);
  let html = await readFile(file, 'utf8');
  if (html.includes('<style data-public-styles>')) {
    html = html.replace(/<style data-public-styles>[\s\S]*?<\/style>/, () => styles);
  } else {
    html = html.replace('  <link rel="stylesheet" href="./site-fonts.css"/>', () => styles);
  }
  html = html.replace(/\s*<link rel="stylesheet" href="\.\/site.min.css"\/>/, '');
  html = html.replaceAll('style="mix-blend-mode:lighten"', 'style="mix-blend-mode:lighten;width:auto"');
  await writeFile(file, html);
}
