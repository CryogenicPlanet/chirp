/** Self-contained recovery styling: no editable assets or external requests. The look is chirp.wiki's, light only;
 * the CSP loads no fonts, so text is the system sans and the wordmark is drawn beside the pixel bird. */
const chirpMark =
	`<svg width="31" height="28" viewBox="0 0 88 80" shape-rendering="crispEdges" aria-hidden="true">` +
	`<path fill="#ed9b83" d="M8 24h16V8h32v8h8v8h16v8H64v16h-8v8H24v-8h-8V40H8zM0 16h8v16H0z"/>` +
	`<path fill="#b9b0df" d="M24 32h8v8h16v8H24z"/><path fill="#ffd166" d="M64 24h16v8H64z"/>` +
	`<path fill="#202a3a" d="M44 16h8v8h-8zM24 56h8v16H16v-8h8zM48 56h8v8h8v8H48z"/></svg>`;
// "chirp" in Pixelify Sans 600, drawn as a path because these pages load no fonts.
const wordmark =
	`<svg width="60" height="20" viewBox="0 0 2506 817" role="img" aria-label="chirp">` +
	`<path fill="#202a3a" d="M89 647V561H0V262H89V175H385V262H475V385H356V299H118V523H356V436H475V561H385V647ZM597 647V0H715V262H774V175H982V262H1072V647H953V299H804V385H715V647ZM1194 647V175H1312V647ZM1194 125V0H1312V125ZM1434 647V262H1523V175H1819V262H1909V385H1790V299H1552V647ZM2031 817V262H2120V175H2416V262H2506V561H2416V647H2149V817ZM2149 523H2387V299H2149Z"/></svg>`;
const brand = `<a class="brand" href="/">${chirpMark}${wordmark}</a>`;
/** Entry screens (sign-in, setup, approval) carry the brand once, in a sky band above the card. */
export const skyHeader = `<header class="sky">${brand}</header>`;
/** Operator screens keep the mark and leave out the sky. */
export const plainHeader = `<header class="bar">${brand}</header>`;

// The landing's favicon.svg, served by boot so a browser tab has an icon before any child runs.
export const chirpIcon =
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#ed9b83" d="M8 20h8V12h16v8h8v8h-8v8H16v-8H8zM8 12h8v8H8zM16 36h8v8h-8z"/>` +
	`<path fill="#161b1d" d="M24 16h4v4h-4z"/></svg>`;

const mono = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
export const authStyles = `
*{box-sizing:border-box}html{background:#f7f5f0}body{margin:0;padding-bottom:48px;background:#f7f5f0;color:#202a3a;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
::selection{background:rgb(255 227 122/.6)}:focus-visible{outline:2px solid #202a3a;outline-offset:3px}
.sky,.bar{padding:24px max(16px,calc(50% - 232px))}.sky{background:#c2dff9;padding-bottom:128px}
.brand{display:inline-flex;align-items:center;gap:8px;color:#202a3a;font-size:24px;font-weight:650;letter-spacing:-.035em;line-height:28px;text-decoration:none;border-radius:4px}.brand svg{flex:none}
.auth-shell{width:min(464px,calc(100% - 32px));margin:0 auto;padding:32px;background:#fff;border-radius:20px;box-shadow:0 0 0 1px rgb(32 42 58/.07),0 1px 3px rgb(32 42 58/.06),0 6px 16px -6px rgb(32 42 58/.08)}.sky+.auth-shell{margin-top:-88px}.auth-shell>:last-child{margin-bottom:0}
h1{margin:0 0 12px;font-size:30px;line-height:1.15;font-weight:650;letter-spacing:-.03em;text-wrap:balance;overflow-wrap:break-word}
p{margin:0 0 16px;color:#3a4558;text-wrap:pretty;overflow-wrap:break-word}strong{color:#202a3a;font-weight:600;overflow-wrap:anywhere}code{font-family:${mono}}
a{color:#202a3a;text-decoration:underline;text-decoration-color:rgb(32 42 58/.3);text-underline-offset:3px}a:hover{text-decoration-color:currentColor}
form{margin:24px 0 0}label{display:block;margin:20px 0 6px;font-size:14px;font-weight:550}
input:not([type=checkbox]){display:block;width:100%;height:44px;padding:0 14px;border:1px solid #948d7e;border-radius:10px;background:#fff;color:#202a3a;font:500 16px ${mono};letter-spacing:.08em}input:focus-visible{outline-offset:2px}
button{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;margin:16px 0 0;padding:10px 16px;border:0;border-radius:10px;background:#202a3a;color:#fff;font:inherit;font-size:15px;font-weight:500;line-height:1.3;cursor:pointer}button:hover{background:#3a4558}button:disabled{opacity:.5;cursor:wait}
.provider,.secondary{margin-top:10px;background:transparent;color:#202a3a;box-shadow:inset 0 0 0 1px #948d7e}.provider:hover,.secondary:hover{background:#f1eee7}
.check{display:flex;align-items:flex-start;gap:10px;margin:14px 0 0;font-size:15.5px;font-weight:400;text-wrap:pretty}.check input{flex:none;width:18px;height:18px;margin:3px 0 0;accent-color:#202a3a}
.note{margin:6px 0 0 28px;font-size:14.5px}.muted{margin-top:20px;color:#5c6577;font-size:14.5px}.code code{font-size:28px;font-weight:500;line-height:1.2;letter-spacing:.16em;color:#202a3a}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.actions button{flex:1 1 180px;margin:0}
.hint{margin:6px 0 0;color:#5c6577;font-size:14px}#status{min-height:1.55em;margin:12px 0 0;color:#5c6577;font-size:14.5px}
.aside{display:flex;flex-wrap:wrap;gap:4px 16px;width:min(464px,calc(100% - 32px));margin:20px auto 0;padding:0 4px;font-size:14px}.aside a{color:#5c6577;text-decoration-color:rgb(92 101 119/.35)}.aside a:hover{color:#202a3a}
@media(max-width:600px){.sky,.bar{padding-top:16px}.sky{padding-bottom:104px}.sky+.auth-shell{margin-top:-72px}.auth-shell{padding:24px 20px}h1{font-size:26px}}
`;
