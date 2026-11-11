// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// ABOUTME: Pulls one function's source out of an admin page that has no build step,
// ABOUTME: so a test can run the page's real code against stubs

// Read one function's source out of the page by name. Braces are only counted
// in code: the scanner walks over strings, template literals (including nested
// `${}` substitutions) and comments, so a brace inside one cannot end the
// function early. That makes extraction survive reformatting of the function it
// pulls, which is the whole point of testing it this way. Regex literals are not
// tracked, so a function containing one cannot be pulled this way.
//
// `mustContain` is the guard on the one failure this cannot otherwise detect.
// The brace scanner below is mode-aware, but the name search on the next line is
// a plain regex over raw source: an earlier textual `function showToast(` in a
// comment or a string hijacks the start index and yields a different function
// that still parses. That failure is silent — no throw, no SyntaxError, just
// tests passing against code the page does not ship. Naming a line that only
// the real body contains turns it into a loud one.
export function extractFunction(source, name, mustContain) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) {
    throw new Error(`extractFunction: no declaration of ${name} in the page`);
  }

  const start = match.index;
  const stack = [];
  let opened = false;

  for (let i = start; i < source.length;) {
    const ch = source[i];
    const next = source[i + 1];
    const mode = stack[stack.length - 1];

    if (mode === "'" || mode === '"') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === mode) { stack.pop(); }
      i += 1;
    } else if (mode === '`') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { stack.pop(); i += 1; continue; }
      if (ch === '$' && next === '{') { stack.push('${'); i += 2; continue; }
      i += 1;
    } else if (mode === '//') {
      if (ch === '\n') { stack.pop(); }
      i += 1;
    } else if (mode === '/*') {
      if (ch === '*' && next === '/') { stack.pop(); i += 2; continue; }
      i += 1;
    } else if (ch === '/' && next === '/') {
      stack.push('//');
      i += 2;
    } else if (ch === '/' && next === '*') {
      stack.push('/*');
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      stack.push(ch);
      i += 1;
    } else if (ch === '{') {
      stack.push('{');
      opened = true;
      i += 1;
    } else if (ch === '}') {
      stack.pop();
      i += 1;
      if (opened && stack.length === 0) {
        const extracted = source.slice(start, i);
        if (!extracted.includes(mustContain)) {
          throw new Error(
            `extractFunction: extracted a ${name} that does not contain ${JSON.stringify(mustContain)} `
            + '— the name search matched an earlier occurrence, so this is the wrong function'
          );
        }
        return extracted;
      }
    } else {
      i += 1;
    }
  }

  throw new Error(`extractFunction: braces never balanced while reading ${name}`);
}
