// Builds dist/demo.html: one self-contained page (engine, tests, About page, avatar) that runs in the browser with no server.
const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');
const eng = fs.readFileSync('src/engine.js', 'utf8'), suite = fs.readFileSync('test/suite.js', 'utf8'), about = fs.readFileSync('public/about.js', 'utf8');
const md = fs.readFileSync('public/about.md', 'utf8'), avatar = fs.readFileSync('public/assets/sid-avatar.svg');
if (/<\/script>/i.test(eng + suite + about)) throw new Error('script end tag inside inlined source');
// JSON for a script tag: stop "</" and line separators from ending or breaking the tag.
const safe = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const data = 'window.ABOUT_MD = ' + safe(md) + ';\nwindow.ABOUT_AVATAR = ' + safe('data:image/svg+xml;base64,' + avatar.toString('base64')) + ';';
html = html.replace('<script src="engine.js"></script>', () => '<script>\n' + eng + '\n</script>')
           .replace('<script src="suite.js"></script>', () => '<script>\n' + suite + '\n</script>')
           .replace('<script src="about.js"></script>', () => '<script>\n' + data + '\n</script>\n<script>\n' + about + '\n</script>');
if (!html.startsWith('<!doctype')) throw new Error('bad start');
if (html.indexOf('src="about.js"') > -1 || html.indexOf('src="engine.js"') > -1) throw new Error('an external script tag was left in');
html = html.replace('<!doctype html>', '<!DOCTYPE html>');
fs.writeFileSync('dist/demo.html', html);
console.log('dist/demo.html', Math.round(html.length / 1024) + ' KB');
