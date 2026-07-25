import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../pages/user.html', import.meta.url), 'utf8');
assert.match(html, /requestAnimationFrame\(/);
assert.doesNotMatch(html, /[🏃🕺🐸ඞ]/u);
assert.doesNotMatch(html, /error-rotate|rotate\(var\(--error/);
assert.match(html, /memify-ak\.png/);
assert.match(html, /pointer-events: none/);
assert.match(html, /gameTimeRemaining/);
assert.match(html, /memifyEnemies/);
assert.match(html, /memifyBullets/);
assert.match(html, /playerHearts/);
assert.match(html, /drawMemifyBullets/);
assert.match(html, /fireMemifyShot/);
assert.match(html, /const crosshairX = this\.mouseX \|\| innerWidth \* \.5;/,
    'crosshair horizontal position must follow the mouse');
assert.doesNotMatch(html, /mousemove[\s\S]{0,180}drawMemifyHUD\(\)/,
    'mousemove must not advance the game simulation');
assert.match(html, /updateMemifyGame\(deltaSeconds\)/,
    'gameplay movement must use elapsed time instead of draw frequency');
assert.match(html, /YOU DIED/);
assert.match(html, /bing-chilling|Bing Chilling/);
console.log('Memify static checks passed');
