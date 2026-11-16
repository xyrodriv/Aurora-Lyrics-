function R(t,e,r){return Math.max(e,Math.min(r,t))}function Mt(t,e){return(t%e+e)%e}function rt(){return typeof CSS<"u"&&CSS.supports("-moz-appearance","none")}function D(t){return Math.round(t*10)/10}function K(t){return t?t.endsWith("ms")?parseFloat(t.slice(0,-2)):t.endsWith("s")?parseFloat(t.slice(0,-1))*1e3:0:0}function Hn(t,e){let r=t.getBoundingClientRect(),i=e.getBoundingClientRect();return new DOMRect(i.x-r.x,i.y-r.y,i.width,i.height)}function X(t,e){let r=0,i=0,s=e;for(;s&&s!==t;)r+=s.offsetLeft,i+=s.offsetTop,s=s.offsetParent;return s!==t?Hn(t,e):new DOMRect(r,i,Math.max(e.offsetWidth,e.scrollWidth),Math.max(e.offsetHeight,e.scrollHeight))}function ft(t){return t.startMs+t.durationMs}function Gn(t,e){return t.startMs<=e&&e<ft(t)}function Ze(t,e,r){return t.filter(i=>Gn(i,e)).reduce((i,s)=>i+tr(s,r(s.easing),e),0)}function Je(t,e,r){if(t.length===1)return Vn(t[0]);let i=[...new Set(t.map(ft))].sort((c,d)=>c-d),s=[],n=e;for(let c of i){let d=t.filter(p=>p.startMs<=n&&ft(p)>=c).map(p=>({curve:p,easing:r(p.easing)})),f=p=>{let y=0;for(let{curve:S,easing:h}of d)y+=tr(S,h,p);return y},u=f(n);s.at(-1)?.offsetPx!==u&&s.push({timeMs:n,offsetPx:u});let m=Math.ceil((c-n)/100);for(let p=1;p<=m;p++){let y=n+(c-n)*p/m;te(f,s[s.length-1],{timeMs:y,offsetPx:f(y)},s)}n=c}let o=i[i.length-1]-e,l=Math.max(...s.map(c=>Math.abs(c.offsetPx)))||1,a=`linear(${s.map(({timeMs:c,offsetPx:d})=>`${Qe(d/l)} ${Qe(100*(c-e)/o)}%`).join(", ")})`;return{keyframes:[{translate:_t(0),easing:a},{translate:_t(l),easing:"linear"}],startMs:e,durationMs:o}}function te(t,e,r,i){let s=(e.timeMs+r.timeMs)/2,n={timeMs:s,offsetPx:t(s)},o=(e.offsetPx+r.offsetPx)/2;if(Math.abs(n.offsetPx-o)<=.1||r.timeMs-e.timeMs<=1){i.push(r);return}te(t,e,n,i),te(t,n,r,i)}function Vn(t){return{keyframes:[{translate:_t(t.fromPx),easing:t.easing},{translate:_t(t.toPx),easing:t.endEasing}],startMs:t.startMs,durationMs:t.durationMs}}function tr(t,e,r){let i=t.durationMs>0?Math.min(1,(r-t.startMs)/t.durationMs):1;return t.fromPx+(t.toPx-t.fromPx)*e(i)}function _t(t){return`0px ${Math.round(t*1e3)/1e3}px`}function Qe(t){return Math.round(t*1e6)/1e6}var it=128;function q(t){let e=t.document.timeline?.currentTime;return typeof e=="number"?e:Date.now()}function Rt(t,e,r){let i=q(t);nr(t,e,[...sr(t,e,i),r],i)}function er(t,e,r){let i=q(t),s=sr(t,e,i);s.some(n=>n.kind===r)&&nr(t,e,s.filter(n=>n.kind!==r),i)}function ee(t,e){let r=t.elementMotions.get(e);if(r){t.elementMotions.delete(e),r.animation.cancel();for(let i of r.curves)i.onEnd?.()}}function rr(t){for(let e of[...t.elementMotions.keys()])ee(t,e)}function ir(t,e){let r=t.elementMotions.get(e);return r?Ze(r.curves,q(t),Ot(t)):0}function sr(t,e,r){return(t.elementMotions.get(e)?.curves??[]).filter(i=>ft(i)>r)}function nr(t,e,r,i){let s=t.elementMotions.get(e);for(let c of s?.curves??[])r.includes(c)||c.onEnd?.();if(r.length===0){t.elementMotions.delete(e),s?.animation.cancel();return}let n=Je(r,i,Ot(t)),o=e.animate(n.keyframes,{duration:n.durationMs,easing:"linear",fill:"none"});o.startTime=n.startMs;let l={animation:o,curves:r};t.elementMotions.set(e,l),s?.animation.cancel();let a=()=>{if(t.elementMotions.get(e)===l){t.elementMotions.delete(e);for(let c of r)c.onEnd?.()}};o.addEventListener("finish",a,{once:!0}),o.addEventListener("cancel",a,{once:!0})}function Ot(t){return e=>{let r=t.easingTables.get(e);return r||(r=Un(t,e),t.easingTables.set(e,r)),Bn(r)}}function Bn(t){return e=>{let r=Math.min(Math.max(e,0),1)*it,i=Math.min(Math.floor(r),it-1);return t[i]+(t[i+1]-t[i])*(r-i)}}function Un(t,e){let r=Float64Array.from({length:it+1},(n,o)=>o/it),{KeyframeEffect:i,Animation:s}=t.window;if(typeof i!="function"||typeof s!="function")return r;try{let n=new i(null,null,{duration:it,easing:e,fill:"both"}),o=new s(n,null);for(let l=0;l<=it;l++)o.currentTime=l,r[l]=n.getComputedTiming().progress??r[l]}catch(n){t.host.log("Line motion easing could not be sampled, so it is treated as linear",e,n)}return r}var kt=new Map,re=class{type;value;defaultValue;requiresLyricReload;manuallySet=!1;constructor(e,r,i,s){this.type=e,this.value=r,this.defaultValue=i,this.requiresLyricReload=s}getNumberValue(){return this.value}getBooleanValue(){return this.value}getStringValue(){return this.value}isManuallySet(){return this.manuallySet}setManuallySet(e){this.manuallySet=e}},$n=/\/\*([\s\S]*?)\*\//g,Yn=/(blyrics-[\w-]+)\s*=\s*([^;]+);/g;function or(t){let e=new Map;for(let[,r]of t.matchAll($n))for(let[,i,s]of r.matchAll(Yn))e.set(i,s.trim());return e}function v(t,e,r=!1){let i=typeof e;if(i!=="number"&&i!=="boolean"&&i!=="string")throw new Error("Invalid type for theme setting");let s=new re(i,e,e,r);return kt.set(t,s),s}function ie(t){let e=!1;t.forEach((r,i)=>{let s=kt.get(i);if(s){let n=s.value;if(s.type==="number"){let o=parseFloat(r);isNaN(o)?(s.value=s.defaultValue,s.setManuallySet(!1)):(s.value=o,s.setManuallySet(!0))}else s.type==="boolean"?(s.value=r.toLowerCase()==="true",s.setManuallySet(!0)):(s.value=r,s.setManuallySet(!0));s.requiresLyricReload&&n!==s.value&&(e=!0)}});for(let[r,i]of kt.entries())!t.has(r)&&i.value!==i.defaultValue?(i.value=i.defaultValue,i.setManuallySet(!1),i.requiresLyricReload&&(e=!0)):t.has(r)||i.setManuallySet(!1);return e}function lr(){let t=[];for(let[e,r]of kt)r.requiresLyricReload&&t.push(`${e}=${String(r.value)}`);return t.join(";")}var ar=750,cr="calc(750ms + log(var(--blyrics-line-scroll-abs-relative-index) + 2, 2.71828) * 80ms + (var(--blyrics-line-scroll-abs-relative-index) + 1) * 20ms)";function x(t,e){return[t,v(t.slice(2),e)]}var oe=[x("--blyrics-line-scroll-duration",cr),x("--blyrics-line-scroll-above-duration","calc(750ms + min(var(--blyrics-line-scroll-abs-relative-index), 6) * 20ms)"),x("--blyrics-line-scroll-active-duration",""),x("--blyrics-line-scroll-below-duration",cr),x("--blyrics-line-scroll-timing-function","var(--blyrics-lyric-scroll-timing-function)"),x("--blyrics-line-scroll-start-easing","var(--blyrics-line-scroll-timing-function)"),x("--blyrics-line-scroll-end-easing","linear"),x("--blyrics-line-scroll-above-start-easing",""),x("--blyrics-line-scroll-active-start-easing",""),x("--blyrics-line-scroll-below-start-easing",""),x("--blyrics-line-scroll-above-end-easing",""),x("--blyrics-line-scroll-active-end-easing",""),x("--blyrics-line-scroll-below-end-easing",""),x("--blyrics-line-scroll-translate-y-start","var(--blyrics-line-scroll-delta-px)"),x("--blyrics-line-scroll-translate-y-end","0px"),x("--blyrics-line-scroll-above-translate-y-start",""),x("--blyrics-line-scroll-active-translate-y-start",""),x("--blyrics-line-scroll-below-translate-y-start",""),x("--blyrics-line-scroll-above-translate-y-end",""),x("--blyrics-line-scroll-active-translate-y-end",""),x("--blyrics-line-scroll-below-translate-y-end","")],zn=oe.filter(([t])=>t.includes("translate-y")).map(([,t])=>t),ur="--blyrics-line-scroll-index",dr="--blyrics-line-scroll-active-index",fr="--blyrics-line-scroll-relative-index",mr="--blyrics-line-scroll-abs-relative-index",pr="--blyrics-line-scroll-side",hr="--blyrics-line-scroll-delta-px",gr="--blyrics-line-scroll-distance-px",Kn=[ur,dr,fr,mr,pr,hr,gr,...oe.map(([t])=>t)];function yr(){return zn.some(t=>t.isManuallySet())}function br(t,e){let r=t.style;r.setProperty(ur,String(e.index)),r.setProperty(dr,String(e.activeIndex)),r.setProperty(fr,String(e.relativeIndex)),r.setProperty(mr,String(Math.abs(e.relativeIndex))),r.setProperty(pr,e.side),r.setProperty(hr,`${e.deltaPx}px`),r.setProperty(gr,`${Math.abs(e.deltaPx)}px`);for(let[i,s]of oe){let n=s.getStringValue().trim();n?r.setProperty(i,n):r.removeProperty(i)}}function Sr(t){for(let e of Kn)t.style.removeProperty(e)}function se(t,e,r,i){let s=`var(--blyrics-line-scroll-${t}, ${i})`;return r?`var(--blyrics-line-scroll-${e}-${t}, ${s})`:s}function wr(t,e,{lineScroll:r}){let i=r.differentialEffects,s=ne(t,e,"transition-duration",a=>se("duration",a.side,i,`${ar}ms`),a=>{let c=K(a.transitionDuration.split(",")[0].trim());return c>0?c:ar}),n=a=>ne(t,e,"transition-timing-function",c=>se(`${a}-easing`,c.side,i,`var(--blyrics-line-scroll-timing-function, ${r.easing})`),c=>c.transitionTimingFunction.trim()||r.easing),o=n("start"),l=n("end");return e.map((a,c)=>({durationMs:s[c],startEasing:o[c],endEasing:l[c]}))}function Er(t,e,{lineScroll:r}){let i=s=>ne(t,e,"translate",n=>{let o=s==="start"?"var(--blyrics-line-scroll-delta-px, 0px)":"0px";return`0 ${se(`translate-y-${s}`,n.side,r.differentialEffects,o)}`},n=>n.translate).map((n,o)=>Xn(n,e[o].heightPx));return{start:i("start"),end:i("end")}}function Xn(t,e){let r=t.trim();if(r===""||r==="none")return 0;let[,i="0px"]=r.match(/calc\([^)]*\)|\S+/g)??[],s=i.replace(/^calc\((.*)\)$/,"$1").replace(/\s+-\s+/g," + -").split(/\s+\+\s+/),n=0;for(let o of s){let l=o.trim().match(/^(-?[\d.]+(?:e-?\d+)?)(px|%)?$/);if(!l||l[2]===void 0&&Number(l[1])!==0)return null;n+=l[2]==="%"?Number(l[1])*e/100:Number(l[1])}return n}function ne(t,e,r,i,s){let n=e.map(({lineElement:l})=>({value:l.style.getPropertyValue(r),priority:l.style.getPropertyPriority(r)}));for(let l of e)l.lineElement.style.setProperty(r,i(l),"important");let o=e.map(l=>s(t.window.getComputedStyle(l.lineElement)));return e.forEach(({lineElement:l},a)=>{let{value:c,priority:d}=n[a];c?l.style.setProperty(r,c,d):l.style.removeProperty(r)}),o}var Ar=120,vr="transform, translate",Lr=2;function Cr(t,e){let r=t.pendingLineScroll;if(r&&Mr(r,e)){t.pendingLineScroll=null,Tr(t,r.plan);return}O(t);let i=_r(t,e);i&&Tr(t,i)}function xr(t,e){let r=t.pendingLineScroll;if(r&&Mr(r,e))return;O(t);let i=_r(t,e);if(!i)return;let{activeLine:s,fromScrollTop:n,toScrollTop:o}=e;t.pendingLineScroll={plan:i,activeLineElement:s.lyricElement,fromScrollTop:n,toScrollTop:o}}function O(t){let e=t.pendingLineScroll;if(e){for(let r of e.plan)Or(t,r.lineElement,r.token);t.pendingLineScroll=null}}function Mr(t,e){return t.activeLineElement===e.activeLine.lyricElement&&Math.abs(t.fromScrollTop-e.fromScrollTop)<=Lr&&Math.abs(t.toScrollTop-e.toScrollTop)<=Lr}function _r(t,e){let{lines:r,config:i}=e,s=r.findIndex(u=>u.lyricElement===e.activeLine.lyricElement);if(!i.enabled.scroll||s<0)return null;let n=e.toScrollTop-e.fromScrollTop,o=yr(),l=[];for(let u=0;u<r.length;u++){let m=r[u];if(!le(m,e.fromScrollTop,e.toScrollTop,e.viewportHeight))continue;let p=m.lyricElement,y=u-s,S=qn(y,n),h=`${S}|${Math.abs(y)}`,g=t.cachedLineScrollTiming.get(h);l.push({lineElement:p,side:S,heightPx:m.height,token:Zn(t,p),relativeIndex:y,timingKey:h,cachedTiming:g}),(o||!g)&&br(p,{index:u,activeIndex:s,relativeIndex:y,side:S,deltaPx:n})}let a=jn(t,l,i),c=o?Er(t,l,i):null,d=Qn(r,s,Math.abs(n),e.continuesEngineScroll),f=a[l.findIndex(u=>u.relativeIndex===0)]?.durationMs;return l.map(({lineElement:u,side:m,token:p},y)=>{let S=a[y];return{lineElement:u,side:m,token:p,durationMs:f===void 0?S.durationMs:f+(S.durationMs-f)*d,startEasing:S.startEasing,endEasing:S.endEasing,startPx:c?.start[y]??n,endPx:c?.end[y]??0}})}function qn(t,e){let r=e<0;return t<0?r?"below":"above":t>0?r?"above":"below":"active"}function jn(t,e,r){let i=e.filter(n=>n.cachedTiming===void 0),s=new Map;return i.length>0&&wr(t,i,r).forEach((n,o)=>{t.cachedLineScrollTiming.set(i[o].timingKey,n),s.set(i[o],n)}),e.map(n=>n.cachedTiming??s.get(n))}function Qn(t,e,r,i){if(i)return 1;let s=t[e],n=[t[e-1],t[e+1]].filter(l=>l!==void 0).map(l=>Math.abs(s.position-l.position)),o=n.length>0?Math.min(...n):s.height;return Math.min(1,o/r)}function Tr(t,e){let r=q(t);for(let i of e){if(!i.lineElement.isConnected||!Rr(t,i.lineElement,i.token))continue;let s={lineElement:i.lineElement,token:i.token,durationMs:i.durationMs};t.runningLineScrolls.push(s),Rt(t,i.lineElement,{kind:"scroll",startMs:r,durationMs:i.durationMs,fromPx:i.startPx,toPx:i.endPx,easing:i.startEasing,endEasing:i.endEasing,onEnd:()=>kr(t,s)})}}function Zn(t,e){let r=++t.lineScrollAnimationToken;return t.lineScrollElementTokens.set(e,r),r}function Rr(t,e,r){return t.lineScrollElementTokens.get(e)===r}function Or(t,e,r){Rr(t,e,r)&&(Sr(e),t.lineScrollElementTokens.delete(e))}function kr(t,e){let r=t.runningLineScrolls.indexOf(e);r!==-1&&t.runningLineScrolls.splice(r,1),Or(t,e.lineElement,e.token)}function Ir(t){let e=new Set(t.runningLineScrolls.map(r=>r.lineElement));for(let r of e)er(t,r,"scroll");for(let r of[...t.runningLineScrolls])kr(t,r)}function le(t,e,r,i){let s=Math.min(e,r),n=Math.max(e,r)+i;return t.position+t.height>=s&&t.position<=n}function Nr(t,e){let r=[t.cachedCreditsItem,t.cachedFooterItem].filter(i=>i!==null);return r.length>0?[...e,...r]:e}function It(t,e){let r=t.querySelector(`:scope > .${e}`);if(!r)return null;let i=X(t,r);return{lyricElement:r,position:i.y,height:i.height}}function Nt(t){O(t),t.cachedDurations.clear(),t.cachedCSSValues.clear(),t.cachedAnimationSettings=null,t.cachedLineScrollTiming.clear()}function H(t,e,r,i){let s=t.cachedCSSValues.get(r);return s===void 0&&(s=t.window.getComputedStyle(e).getPropertyValue(r).trim()||i,t.cachedCSSValues.set(r,s)),s}function mt(t,e,r){let i=t.cachedDurations.get(r);return i===void 0&&(i=K(H(t,e,r,"0ms")),t.cachedDurations.set(r,i)),i}function ae(t,e,r,i){let s=Number.parseFloat(H(t,e,r,`${i}`));return Number.isFinite(s)?s:i}function Pr(t,e){let r=(s,n)=>H(t,e,s,n),i=(s,n)=>ae(t,e,s,n);return{string:r,number:i,durationMs:(s,n)=>Math.max(K(r(s,n)),1),fraction:(s,n)=>R(i(s,n),0,1),flag:(s,n)=>{let o=r(s,n?"1":"0").toLowerCase();if(o==="false"||o==="off"||o==="none")return!1;let l=Number.parseFloat(o);return Number.isFinite(l)?l>0:n}}}var Jn=rt(),Dr=.06,to=.1,j=-1,M={lastTime:0,lastPlayState:!1,lastEventCreationTime:j,smoothedTime:0,smoothedAt:j};function eo(t,e,r,i,s){if(e===j)return r;let n=Math.max(0,i-e)/1e3,o=t+n*s,l=r-o;return l>=0||Math.abs(l)>=Dr?r:o+l*Math.min(1,n*to)}var ro=.5;function Fr(t,{isPlaying:e,eventCreationTime:r,followPausedSeeks:i},s,n){let o=(r-M.lastEventCreationTime)/1e3,l=Math.abs(t-M.lastTime-o)>ro,a=r===j,c=a&&e&&t<M.lastTime-Dr,d=i&&!e&&!M.lastPlayState&&t!==M.lastTime;M.lastTime=t,M.lastPlayState=e,M.lastEventCreationTime=r;let f=e&&!a?(n-r)/1e3:0,u=t+f;return Jn&&(e&&!l&&(u=eo(M.smoothedTime,M.smoothedAt,u,n,s)),M.smoothedTime=u,M.smoothedAt=e?n:j),{timeS:u,isPlaying:e,jumped:l,mediaClockRanBackwards:c,seekedWhilePaused:d}}function ce(t,e,r){return(t.syncType==="richsync"?mt(t,e,"--blyrics-richsync-timing-offset")/1e3-r.richsyncOffsetTrim:mt(t,e,"--blyrics-timing-offset")/1e3-r.lineOffsetTrim)-r.globalLyricOffset-r.lyricOffset}function Wr(t,e){let r=t.lastTickOptions,i=t.lyricsContainer;return!r||!i?e:Math.max(0,e-ce(t,i,r))}var Pt="blyrics-container",Dt="blyrics--line",G="blyrics--word",Hr="blyrics--letter",Ft="blyrics-footer",P="blyrics-credits",Gr="blyrics-credits__text",Vr="blyrics-credits__names",pt="blyrics--active",V="blyrics--animating",Wt="blyrics--paused",Br="blyrics-zero-dur-animate",st="blyrics-user-scrolling",Q="data-word-state",B="upcoming",Ur="active",$r="past",Ht="blyrics-background-lyric",Yr="blyrics-explicit",W="blyrics-rtl",Z="blyrics--translated",nt="blyrics--romanized",zr="blyrics-content-line",ue="blyrics-line-main",Kr="blyrics-background-line",Xr="blyrics-word-group",qr="blyrics-word-group-long",jr="blyrics-word-highlight",Qr="blyrics-word-highlight--lettered",Zr="blyrics-word-highlight--sweep",de="blyrics-word-highlight--context",Jr="blyrics-sweep-cell",ti="blyrics-sweep-context",ei="blyrics-sweep-window",ri="blyrics-sweep-clone",ii="blyrics-sweep-target",si="blyrics-sweep-mask",ni="blyrics-sweep-text",fe="blyrics-sweep-glow",ht="blyrics-highlight-run",oi="blyrics-line-synced-word",gt="blyrics-bidi-run",me="blyrics-bidi-sensitive",pe="blyrics-custom-style";var he=new Set;var io=v("blyrics-passive-scroll-enabled",!0),li=v("blyrics-passive-scroll-seconds-per-line",3.5),so=v("blyrics-passive-scroll-bottom-pause-s",1.5),no=v("blyrics-passive-scroll-reset-duration-s",.6),oo=v("blyrics-passive-scroll-top-pause-s",.8),lo=.5,ao=1;function yt(t){return t.lyricsContainer?.dataset.noLyrics==="true"}function bt(t){return t.lyricsContainer!==null&&t.syncType==="none"&&!yt(t)}function ai(t){t.passiveRAFId===null&&(t.passiveRAFId=t.window.requestAnimationFrame(()=>ci(t)))}function ot(t){t.passiveRAFId!==null&&(t.window.cancelAnimationFrame(t.passiveRAFId),t.passiveRAFId=null)}function ci(t){t.passiveRAFId=null,!(!t.passiveScrollEnabled||!io.getBooleanValue()||!bt(t))&&(co(t,M.lastPlayState),t.passiveRAFId=t.window.requestAnimationFrame(()=>ci(t)))}function co(t,e){if(!t.host.isViewVisible()||t.host.isLoaderActive())return;let r=t.host.getScrollElement();if(!r)return;let i=Date.now();if(t.passiveLastWallTime>0&&e&&(t.passiveScrollAccumulatedTime+=Math.min((i-t.passiveLastWallTime)/1e3,lo)),t.passiveLastWallTime=i,t.scrollResumeTime>i)return;t.wasUserScrolling&&uo(t,r);let s=t.lines.length*li.getNumberValue(),n=r.scrollHeight-r.clientHeight;if(t.lines.length===0||n<=0)return;let o=fo(t.passiveScrollAccumulatedTime,s,n);r.scrollTop=o,t.passiveScrollTop=r.scrollTop}function ui(t){let e=t.host.getScrollElement()?.scrollTop;return t.passiveScrollTop!==null&&e!==void 0&&Math.abs(e-t.passiveScrollTop)<ao}function uo(t,e){t.host.setResumeAffordanceVisible(!1),t.lyricsContainer?.classList.remove(st),t.wasUserScrolling=!1;let r=e.scrollHeight-e.clientHeight;if(r<=0)return;let i=t.lines.length*li.getNumberValue();t.passiveScrollAccumulatedTime=e.scrollTop/r*i}function fo(t,e,r){let i=e,s=i+so.getNumberValue(),n=no.getNumberValue(),o=s+n,l=t%(o+oo.getNumberValue());if(l<i)return l/e*r;if(l<s)return r;if(l<o){let a=1-(l-s)/n;return r*a*a}return 0}var mo="Pausing Lyrics Autoscroll Due to User Scroll",po=25e3,ho=5e3,go=2e3;function di(t){t.scrollResumeTime=0}function fi(t,e){if(e){if(ui(t))return}else if(t.skipScrolls>0){t.skipScrolls--,t.skipScrollsDecayTimes.shift();return}if(O(t),t.host.isLoaderActive())return;let r=Date.now();t.scrollResumeTime<r&&t.host.log(mo),t.scrollResumeTime=r+(e?ho:po),t.wasUserScrolling=!0,t.host.setResumeAffordanceVisible(!0),t.lyricsContainer?.classList.add(st)}function mi(t,e,r){return e!==t.lyricWidth||r!==t.lyricHeight}function pi(t,e,r,i){t.scrollPos=r;let s=e.scrollTop;e.scrollTop=r,e.scrollTop!==s&&ge(t,i)}function ge(t,e){t.skipScrolls+=1,t.skipScrollsDecayTimes.push(e+go)}function hi(t){t.wasUserScrolling=!0}function gi(t,e,r){let i=t.skipScrollsDecayTimes.findIndex(n=>n>e),s=i===-1?t.skipScrollsDecayTimes.length:i;t.skipScrollsDecayTimes=t.skipScrollsDecayTimes.slice(s),t.skipScrolls=Math.max(r?1:0,t.skipScrolls-s)}var be=new WeakMap,ye=new WeakMap;function yi(t,e,r,i,s){let n=t.waveAnimationPool,o=n[n.length-1],l=o?.effect;if(o&&l&&typeof l.setKeyframes=="function")return n.pop(),l.target=e,ye.get(o)!==i&&(l.setKeyframes(r),ye.set(o,i)),l.updateTiming(s),o.play(),o;let a=e.animate(r,s);return be.set(a,n),ye.set(a,i),a}function bi(t){N(t),J(t,Wt,!1),J(t,V,!1),t.wordState=B,t.lyricElement.setAttribute(Q,B),t.highlightElement.setAttribute(Q,B)}function N(t){for(let e of t.animations){e.cancel();let r=be.get(e);r&&r.push(e)}t.animations=[]}function yo(t){N(t);for(let e of t.parts)N(e)}function Si(t){return t.animations.length>0||t.parts.some(e=>e.animations.length>0)}function Se(t){t.isAnimating=!1,t.isAnimationPlayStatePlaying=!1,t.accumulatedOffsetMs=0}function I(t){yo(t),Se(t)}function J(t,e,r){t.lyricElement.classList.toggle(e,r),"highlightElement"in t&&t.highlightElement.classList.toggle(e,r)}function Gt(t,e){let r=[t,...t.parts];for(let i of r){J(i,Wt,!e);for(let s of i.animations)e?s.play():s.pause()}}function wi(t){t.lyricElement.classList.remove(V);for(let e of[t,...t.parts])J(e,Wt,!1)}function we(t,e){let r=t.parts,i=t.time+t.duration;for(let s=0;s<r.length;s++){let n=r[s],o=n.duration>0?n.time+n.duration:r[s+1]?.time??i,l=$r;e<n.time?l=B:e<o&&(l=Ur),n.wordState!==l&&(n.wordState=l,n.lyricElement.setAttribute(Q,l),n.highlightElement.setAttribute(Q,l))}}function U(t){if(!t||t==="auto"||t==="und")return"";try{return Intl.getCanonicalLocales(t.trim().replaceAll("_","-"))[0]??""}catch{return""}}function bo(t){return/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t)?"ja":/\p{Script=Hangul}/u.test(t)?"ko":null}function Ei(t){return/^(ja|ko|zh|yue)(-|$)|-(Hans|Hant)(-|$)/i.test(t)}function Vt(t,e){let r=U(e),i=t.map(l=>l.isInstrumental?null:bo(l.words)),s=new Set(i.filter(l=>l!==null)),n=s.size===1?[...s][0]:"",o=Ei(r)?r:n||r;return t.map((l,a)=>{if(l.isInstrumental)return"";let c=i[a];return c&&o.split("-")[0]!==c?c:/\p{Script=Han}/u.test(l.words)&&!Ei(o)?"":o})}function St(t,e){let r=U(e);t.lang=r;let i=t.querySelector(`.${nt}`);i&&(i.lang=`${r?new Intl.Locale(r).language:"und"}-Latn`)}var So=new Intl.Segmenter(void 0,{granularity:"grapheme"}),wo=/(?:[\u{94D}\u{9CD}\u{A4D}\u{ACD}\u{B4D}\u{C4D}\u{CCD}\u{D4D}\u{1039}\u{17D2}\u{1A60}\u{1B44}\u{1BAB}\u{2D7F}\u{A9C0}\u{AAF6}\u{10A3F}\u{11046}\u{1107F}\u{110B9}\u{11133}\u{111C0}\u{11235}\u{1134D}\u{113D0}\u{11442}\u{114C2}\u{115BF}\u{1163F}\u{116B6}\u{11839}\u{1193E}\u{119E0}\u{11A47}\u{11A99}\u{11C3F}\u{11D45}\u{11D97}\u{11F42}]\u200D?|\u200D\u0DCA|\u0DCA\u200D)$/u,Eo=/^\p{L}/u,Lo=/^\p{M}/u,To=(t,e)=>t.endsWith("\u0B95\u0BCD")&&e.startsWith("\u0BB7")||t.endsWith("\u0BB8\u0BCD")&&e.startsWith("\u0BB0\u0BC0");function Ee(t){return Ao(Array.from(So.segment(t),({segment:e})=>e))}function Ao(t){let e=[],r="";for(let i of t)e.length>0&&(Lo.test(i)||Eo.test(i)&&(wo.test(r)||To(r,i)))?e[e.length-1]+=i:e.push(i),r=i;return e}function Li(t,e){let r=t.target;if(!(e.closest(`.${Pt}`)?.dataset.sync==="richsync")||!t.altKey)return parseFloat(e.dataset.time||"0");let n=r.closest(`.${G}`);if(!n){let o=e.querySelectorAll(`.${G}`),l=1/0;o.forEach(a=>{let c=a.getBoundingClientRect(),d=c.left+c.width/2,f=c.top+c.height/2,u=Math.hypot(t.clientX-d,t.clientY-f);u<l&&(l=u,n=a)})}return n?parseFloat(n.dataset.time||"0"):null}var $=t=>/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Mandaic}\p{Script=Hanifi_Rohingya}\p{Script=Samaritan}\p{Script=Yezidi}\p{Script=Mende_Kikakui}\p{Script=Old_Hungarian}]/u.test(t),Ai=t=>/[\p{Script_Extensions=Arabic}\p{Script_Extensions=Syriac}\p{Script_Extensions=Nko}\p{Script_Extensions=Mongolian}\p{Script_Extensions=Adlam}\p{Script_Extensions=Mandaic}\p{Script_Extensions=Hanifi_Rohingya}]/u.test(t);var Ti=t=>t.toLowerCase().replaceAll(/\p{P}/gu,"").trim(),vi=(t,e)=>Ti(t)===Ti(e);var Te=v("blyrics-disable-richsync",!1,!0),vo=v("blyrics-line-synced-animation-delay",50,!0),Co=v("blyrics-long-word-threshold",1500,!0),xo=v("blyrics-long-word-wrap-threshold",10,!0),Mo=v("blyrics-letter-wave",!0,!0),Oi=v("blyrics-hide-credits",!1,!0),_o=/[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u,ki=/^\s+$/u;function Ae(t,e){for(let r=e+1;r<t.length;r++)if(!t[r].isInstrumental&&t[r].agent)return t[r].agent;for(let r=e-1;r>=0;r--)if(!t[r].isInstrumental&&t[r].agent)return t[r].agent}function ve(t,e){for(let r=e+1;r<t.length;r++)if(!t[r].isInstrumental&&t[r].words?.trim())return $(t[r].words);for(let r=e-1;r>=0;r--)if(!t[r].isInstrumental&&t[r].words?.trim())return $(t[r].words);return!1}function Ii(t){return!Te.getBooleanValue()&&t.some(r=>!r.isInstrumental&&r.parts?.some(i=>i.durationMs!==0)===!0)?"richsync":t.every(r=>r.startTimeMs===0)?"none":"synced"}function Ro(t,e,r,i,s,n,o){return{time:t.startTimeMs/1e3,duration:t.durationMs/1e3,lyricElement:e,highlightElement:r,sweep:o,sweepContext:r.classList.contains(de)?{}:void 0,letterElements:s,highlightLetterElements:n,wobbleElements:i,animations:[],wordState:B}}function Ni(t,e,r){return{lyricElement:t,time:e/1e3,duration:r/1e3,parts:[],isScrolled:!1,isAnimationPlayStatePlaying:!1,accumulatedOffsetMs:0,isAnimating:!1,lastAnimSetupAt:0,isSelected:!1,height:-1,position:-1,decorations:new Map,animations:[]}}function Oo(t){for(let e of t){if($(e))return"rtl";if(_o.test(e))return"ltr"}return"auto"}function wt(t,e){let r=Oo(e);t.dir="auto",r==="rtl"?(t.classList.add(W),t.dataset.direction="rtl"):r==="ltr"&&(t.dataset.direction="ltr")}function ko(t,e){$(e)&&t.classList.add(me)}function Io(t){let e=t.words.match(/\s+|\S+/gu)??[];if(e.length===0)return[];let r=[],i=0;for(let o of e){if(ki.test(o)){r.push({kind:"space",text:o}),i+=o.length;continue}r.push({kind:"part",text:o,part:{words:o,isBackground:t.isBackground,backgroundGroup:t.backgroundGroup,explicit:t.explicit}})}let s=t.words.length-i,n=0;return r.map(o=>{if(o.kind==="part"){let l=t.startTimeMs+Math.round(t.durationMs*n/s),a=t.startTimeMs+Math.round(t.durationMs*(n+o.text.length)/s);return n+=o.text.length,{...o,part:{...o.part,startTimeMs:l,durationMs:a-l}}}return o})}function No(t){return t.flatMap(Io)}function Po(t,e){let r=[],i=null,s=()=>{i&&i.tokens.length>0&&r.push(i),i=null};for(let n of t){if(n.kind==="space"){s(),r.push(n);continue}let o=n.part?.isBackground===!0,l=e?n.part?.backgroundGroup:void 0;(!i||i.isBackground!==o||i.backgroundGroup!==l)&&(s(),i={text:"",isBackground:o,backgroundGroup:l,tokens:[]}),i.text+=n.text,i.tokens.push(n)}return s(),r}function Do(t,e,r,i){if(r.length<=i)return e.textContent=r.join(""),!1;for(let s=0;s<r.length;s+=i)e.appendChild(t.createTextNode(r.slice(s,s+i).join(""))),s+i<r.length&&e.appendChild(t.createElement("wbr"));return!0}function Fo(t,e,r){return e.style.setProperty("--letters",String(r.length)),r.map(i=>{let s=t.createElement("span");return s.classList.add(Hr),s.textContent=i,e.appendChild(s),s})}function Ci(t,e,r,i,s,n){if(s)return Fo(t,e,r);n?e.textContent=r.join(""):Do(t,e,r,i)}var Wo=["wide","tight"];function Bt(t,e,r){let i=t.createElement("span");i.classList.add(si);let s=t.createElement("span");s.classList.add(ni),i.appendChild(s);let n=r(s),o=Wo.map(l=>{let a=t.createElement("span");a.classList.add(fe,`${fe}--${l}`);let c=r(a);return s.appendChild(a),{glow:a,letters:c}});return e.classList.add(Jr),e.appendChild(i),{mask:i,text:s,letters:n,glows:o}}function Ho(t,e){return e.map(r=>{let i=r.textContent??"";return r.textContent="",Bt(t,r,s=>{s.appendChild(t.createTextNode(i))})})}function Go(t,e,r,i,s,n){let o=t.createElement("span"),l=t.createElement("span");l.classList.add(jr);let a,c,d,f=i||!s&&e.words.length>r?Ee(e.words):[e.words];for(let u of[o,l]){if(u.classList.add(G),u.dir="auto",e.durationMs===0&&(u.classList.add(Br),u.classList.add(oi)),$(e.words)&&u.classList.add(W),e.durationMs>Co.getNumberValue()&&(u.dataset.longWord="true"),e.isBackground&&u.classList.add(Ht),e.explicit&&u.classList.add(Yr),i&&(u.classList.add("blyrics-word--lettered"),u===l&&u.classList.add(Qr)),u===l&&n){let m=Bt(t,l,p=>Ci(t,p,f,r,i,s));a=[m],d=m.letters}else{let m=Ci(t,u,f,r,i,s);u===o?c=m:d=m,u===l&&m&&(a=Ho(t,m))}u===l&&a?l.classList.add(Zr):u===l&&l.classList.add(de),u.dataset.time=String(e.startTimeMs/1e3),u.dataset.duration=String(e.durationMs/1e3),u.dataset.content=e.words,u.setAttribute(Q,B),u.style.setProperty("--blyrics-duration",e.durationMs+"ms")}return{span:o,highlight:l,letters:c,highlightLetters:d,sweep:a}}function Vo(t,e,r,i){let s=Math.max(1,xo.getNumberValue()),n=$(e.text)&&[...e.text].some(u=>/[\p{Letter}\p{Number}]/u.test(u)&&!$(u)),o=Ai(e.text),l=Mo.getBooleanValue()&&!o&&!n,a=e.text.length>s*2&&Ee(e.text).length>s*2,c=t.createElement("span"),d=t.createElement("span"),f=!i&&!a;for(let u of[c,d])u.classList.add(Xr),u.dir="auto",u.dataset.content=e.text,a&&u.classList.add(qr),e.isBackground&&u.classList.add(Ht);for(let u of e.tokens){if(u.kind==="space")continue;let{span:m,highlight:p,letters:y,highlightLetters:S,sweep:h}=Go(t,u.part,s,l,o,f),g=c.childNodes.length===0?[c,d]:[];r.parts.push(Ro(u.part,m,p,g,y,S,h)),c.appendChild(m),d.appendChild(p)}return{lyricGroup:c,highlightGroup:d}}function xi(t,e,r){let i=t.createElement("div");return i.classList.add(e),wt(i,r),ko(i,r),i}function Le(t,e){let r=t.createElement("span");return r.classList.add(gt),wt(r,e),r}function Mi(t,e){let r=Le(t,e);return r.classList.add(ht),r.setAttribute("aria-hidden","true"),r}function _i(t,e,r){if(!r)return t.createTextNode(e);let i=t.createElement("span");return i.classList.add(Ht),i.textContent=e,i}function Pi(t,e,r,i,s={splitBackgroundLine:!0}){let n=e.map(h=>h.words).join(""),o=s.splitBackgroundLine?e.filter(h=>h.isBackground!==!0).map(h=>h.words).join(""):n,l=h=>e.filter(g=>g.isBackground===!0&&(g.backgroundGroup??0)===h).map(g=>g.words).join(""),a=xi(t,ue,o),c=Le(t,o),d=Mi(t,o),f=Po(No(e),s.splitBackgroundLine),u=new Map,m=h=>{let g=u.get(h);if(!g){let w=l(h);g={line:xi(t,Kr,w),run:Le(t,w),highlightRun:Mi(t,w),used:!1},g.line.appendChild(g.highlightRun),g.line.appendChild(g.run),u.set(h,g)}return g};m(0);let p="",y="";a.appendChild(d),a.appendChild(c);for(let h of f)if("kind"in h)p+=h.text,y+=h.text;else{let g=s.splitBackgroundLine&&h.isBackground,w=g?m(h.backgroundGroup??0):null,T=w?w.run:c,b=w?w.highlightRun:d,E=g?y:p;T.childNodes.length>0&&E.length>0&&(T.appendChild(_i(t,E,g)),b.appendChild(_i(t,E,g)));let A=w?w.line:a,{lyricGroup:_,highlightGroup:L}=Vo(t,h,r,A.classList.contains(me));T.appendChild(_),b.appendChild(L),w?(w.used=!0,y=""):p=""}let S=[...u].filter(([,h])=>h.used).sort(([h],[g])=>h-g).map(([,h])=>h);i.appendChild(a);for(let h of S)i.appendChild(h.line);return a}function Di(t){let e=[],r=t.words.match(/\s+|\S+/gu)??[],i=0;for(let s of r){let n=ki.test(s),o=t.startTimeMs+i*vo.getNumberValue();e.push({startTimeMs:o,words:s,durationMs:0}),n||(i+=1)}return e}function Fi(t,e,r){if(r){e.style.cursor="unset";return}e.addEventListener("click",i=>{let s=Li(i,e);s!==null&&t(s)})}function Bo(t,e){let r=[...t.querySelector(`:scope > .${ue}`)?.querySelectorAll(`:scope > .${gt}`)??[]].find(i=>!i.classList.contains(ht));return r?.textContent!=null&&vi(r.textContent,e)}var Ri=new WeakMap;function Wi(t){let e=t.querySelector(`:scope > .${Z}`);return e===null?!1:(e.remove(),!0)}function Hi(t,e){let r=Array.from(t.lyricElement.childNodes).filter(i=>i.classList?.contains(nt)===!0||i.classList?.contains(Z)===!0);for(let i of r)t.parts=t.parts.filter(s=>i.contains(s.lyricElement)?(bi(s),e.parts.push(s),!1):!0),e.lyricElement.appendChild(i)}function Gi(t,e,r,i){let s=JSON.stringify([r,U(i)]),n=e.querySelector(`:scope > .${Z}`);if(n!==null){if(Ri.get(n)===s)return;n.remove()}if(Bo(e,r))return;let o=t.createElement("div");o.classList.add(Z,zr),o.dir="auto",o.lang=U(i),wt(o,r),o.textContent=r,Ri.set(o,s),e.appendChild(o)}var lt=v("blyrics-image-highlights",!1,!0);function Uo(t){let e=/^url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s'"()]+))\s*\)$/i.exec(t.trim());return e?e[1]??e[2]??e[3]:null}function Et(t,e){if(!(!t||!lt.getBooleanValue()))for(let r of t.querySelectorAll(".blyrics--instrumental-icon")){let i=r.querySelector(".blyrics-instrumental-image");if(!i)continue;let s=Uo(e.getComputedStyle(r).getPropertyValue("--blyrics-highlight-image"));s!==i.getAttribute("href")&&(r.removeAttribute("data-image-ready"),i.onload=()=>{i.getAttribute("href")===s&&r.setAttribute("data-image-ready","")},i.onerror=()=>r.removeAttribute("data-image-ready"),s?i.setAttribute("href",s):i.removeAttribute("href"))}}var Ut=.4,Vi=rt(),Bi=[{opacity:0},{opacity:-.002},{opacity:0}],Ce=200;function tt({highlight:t}){return{easing:t.swipeEasing,startFrom:t.swipeStartFrom,startTo:t.swipeStartTo,endFrom:t.swipeEndFrom,endTo:t.swipeEndTo}}function $o(t,e,r){if(t.easing!=="linear"||r<=0||e<=0)return null;let i=Number.parseFloat(t.startFrom),s=Number.parseFloat(t.startTo),n=Number.parseFloat(t.endFrom),o=Number.parseFloat(t.endTo);if(![i,s,n,o].every(Number.isFinite)||s<=i||o<=n)return null;let a=m=>i+(s-i)*m/r,c=m=>n+(o-n)*m/r,d=m=>r*(m-n)/(o-n),f=m=>r*(m-i)/(s-i),u=[];for(let m=0;m<e;m++){let p=R(d(m/e),0,r),y=R(f((m+1)/e),0,r);u.push({delayMs:p,durationMs:Math.max(y-p,1),from:{start:a(p),end:c(p)},to:{start:a(y),end:c(y)}})}return u}function Ui(t,e,r,i,s,n){let o=$o({...t,easing:"linear"},e,i);if(!o)return Yo(e,r,n);let l=n*Ut;return o.map(a=>{let c=a.delayMs-s,d=a.durationMs;return d>l?{delayMs:c,durationMs:d/Ut}:{delayMs:c+d-l,durationMs:n}})}function Yo(t,e,r){return Array.from({length:t},(i,s)=>({delayMs:e*s/t,durationMs:r}))}function Me(t){let e=Number.parseFloat(t.startFrom),r=Number.parseFloat(t.startTo),i=Number.parseFloat(t.endTo)-r;return![e,r,i].every(Number.isFinite)||r<=e?null:{startFrom:e,startTo:r,fade:Math.max(i,0)}}var xe=1.5;function $i(t,e){let r=Me(t);return r&&e.width>0?r.fade/e.width:0}function Yi(t,e){return Ki(t,e.start)}function zi(t,e){return Ki(t,e.start+e.width)}function Ki(t,e){let r=Me(t);return r?R((e-r.startFrom)/(r.startTo-r.startFrom),0,1):0}function Xi(t,e,r){let i=Me(t);if(!i||e.width<=0)return null;let s=i.fade/e.width,n=3+s,o=r?-1:1,l=m=>(i.startFrom+(i.startTo-i.startFrom)*m-e.start)/e.width,a=m=>(m*e.width+e.start-i.startFrom)/(i.startTo-i.startFrom),c=[0,a(-s),a(xe),1].map(m=>R(m,0,1)),d=c.filter((m,p)=>c.indexOf(m)===p),f=[],u=[];for(let m of d){let p=o*(R(l(m),-s,xe)-xe);f.push({offset:m,translate:`${p*100/n}% 0`}),u.push({offset:m,translate:`${-p*100}% 0`})}return{mask:f,text:u}}function qi(t,e){for(let i of t.parts)i.sweepContext&&(i.sweepContext.unplaced=!0);let r=t.parts.flatMap(i=>i.sweepContext?[Ko(i)]:[]);for(let i of r)i&&Xo(i,e)}var zo=["--blyrics-lyric-active-color","--blyrics-glow-color"];function Ko(t){let e=t.lyricElement,r=e.closest(`.${gt}:not(.${ht})`),i=r?.parentElement;if(!r||!i||!t.sweepContext||typeof e.getClientRects!="function")return null;let s=i.getBoundingClientRect(),n=i.offsetWidth>0?s.width/i.offsetWidth:1,o=u=>({x:(u.left-s.left)/n,y:(u.top-s.top)/n,width:u.width/n,height:u.height/n}),l=o(r.getBoundingClientRect()),a=Array.from(e.getClientRects(),o).filter(u=>u.width>0);if(a.length===0)return null;let c=e.ownerDocument.defaultView?.getComputedStyle(t.highlightElement),d=zo.map(u=>[u,c?.getPropertyValue(u).trim()??""]),f=JSON.stringify([[l,a].flat().map(u=>Object.values(u).map(Math.round)),d]);return{part:t,context:t.sweepContext,contentLine:i,run:r,runBox:l,fragments:a,colors:d,key:f}}function ji(t){return t.isAnimating&&t.parts.some(e=>e.sweepContext?.unplaced)}function Xo({part:t,context:e,contentLine:r,run:i,runBox:s,fragments:n,colors:o,key:l},a){let c=l+JSON.stringify(tt(a));if(e.placedAt===c&&e.host?.isConnected){e.unplaced=!1;return}e.host?.remove();let d=r.ownerDocument,f=d.createElement("span");f.classList.add(ti),f.setAttribute("aria-hidden","true");for(let[g,w]of o)w&&f.style.setProperty(g,w);let u=Array.from(i.querySelectorAll(`.${G}`)).indexOf(t.lyricElement),m=i.cloneNode(!0);m.classList.add(ri),m.querySelectorAll(`.${G}`)[u]?.classList.add(ii);let p=n.reduce((g,w)=>g+w.width,0),y=t.lyricElement.classList.contains(W)?"rtl":"ltr",S=0,h=n.map(g=>{let w=d.createElement("span");w.classList.add(ei),w.dir=y,Object.assign(w.style,{left:`${g.x}px`,top:`${g.y}px`,width:`${g.width}px`,height:`${g.height}px`});let T={start:S/p,width:g.width/p};S+=g.width,w.style.setProperty("--blyrics-sweep-fade",String($i(tt(a),T)));let b=Bt(d,w,E=>{let A=m.cloneNode(!0);Object.assign(A.style,{left:`${s.x-g.x}px`,top:`${s.y-g.y}px`,width:`${s.width}px`}),E.appendChild(A)});return f.appendChild(w),{...b,span:T}});r.appendChild(f),e.host=f,e.placedAt=c,e.unplaced=!1,t.sweep=h.length>0?h:void 0}var qo="100% 0px 100% 0px";function $t(t){t.lineCullObserver?.disconnect(),t.lineCullObserver=null,Lt(t);let e=t.window.IntersectionObserver;if(t.layout==="stage"||typeof e!="function"||t.lines.length===0)return;t.host.getScrollElement()?.style.setProperty("overflow-anchor","none"),Qo(t);let r=new e(i=>{for(let s of i){let n=s.target;s.isIntersecting?(t.culledLineElements.delete(n)&&Qi(n),jo(t,n)):t.culledLineElements.has(n)||(Zo(n),t.culledLineElements.add(n))}},{root:null,rootMargin:qo,threshold:0});for(let i of t.lines)r.observe(i.lyricElement);t.lineCullObserver=r}function jo(t,e){let r=t.lines.find(i=>i.lyricElement===e);r&&ji(r)&&I(r)}function Lt(t){for(let e of t.culledLineElements)Qi(e);t.culledLineElements=new Set}function Qo(t){let e=t.lines.map(r=>r.lyricElement.offsetHeight);t.lines.forEach((r,i)=>{r.lyricElement.style.setProperty("contain-intrinsic-block-size",`auto ${e[i]}px`)})}function Zo(t){t.style.setProperty("content-visibility","auto")}function Qi(t){t.style.removeProperty("content-visibility")}function Tt(t,e,r,i,s){let n=new Set;for(let o of e)le(o,r,i,s)&&(o.lyricElement.style.setProperty("will-change",vr),n.add(o.lyricElement));for(let o of t.visibleWillChangeElements)n.has(o)||o.style.removeProperty("will-change");t.visibleWillChangeElements=n}function at(t){for(let e of t.visibleWillChangeElements)e.style.removeProperty("will-change");t.visibleWillChangeElements=new Set}var Y="(prefers-reduced-motion: reduce)";var Jo=350,tl="cubic-bezier(0.25, 1, 0.5, 1)",At=.5;function Yt(t,e,r){Rt(t,e,{kind:"slide",startMs:q(t),durationMs:Jo,fromPx:r,toPx:0,easing:tl,endEasing:"linear"})}function _e(t,e){return t.window.matchMedia(Y).matches?!1:t.window.getComputedStyle(e).getPropertyValue("--blyrics-animate-decoration-entry").trim()!=="0"}function Zi(t){return[...t.querySelectorAll(`.${nt}`),...t.querySelectorAll(`.${Z}`)]}function Ji(t){let e=t.lyricsContainer;if(!e||t.layout==="stage"||!_e(t,e))return null;let r=t.lines.map(i=>({line:i,position:i.position,decorations:new Map(i.decorations)}));return()=>{for(let{line:i,position:s,decorations:n}of r){let o=s-i.position;Math.abs(o)>=At&&Yt(t,i.lyricElement,o);for(let[l,a]of n){let c=i.decorations.get(l);if(c===void 0)continue;let d=a-c-o;Math.abs(d)>=At&&Yt(t,l,d)}}}}function ts(t,e){let r=t[e-1];return r!==void 0&&r.kind==="line"&&t[e].kind!=="blank"&&t[e].start<r.end-.15}function el(t){return t.map((e,r)=>{let i=e.start-.5,s=t[r-1];return e.kind==="credits"&&s?.kind==="instrumental"?(s.start+s.end)/2:s?.kind!=="line"||ts(t,r)?i:Math.max(i,Math.min(s.end,e.start)-.12)})}function es(t,e){let r=el(t),i=-1;r.forEach((o,l)=>{o<=e&&(i=l)});let s=t.map((o,l)=>l<i?"gone":l>i?"queued":"current");if(i<0)return s;let n=t[i-1];return n?.kind==="line"&&ts(t,i)&&e<n.end&&(s[i-1]="previous"),s}function rs(t,e,r,i,s,n){let o={left:t,width:e};if(r.width<=0||e<=0||n===1)return o;let l=r.width/e,a=Number.POSITIVE_INFINITY,c=Number.NEGATIVE_INFINITY;for(let p of i)p.width<=0||(a=Math.min(a,(p.x-r.x)/l),c=Math.max(c,(p.x+p.width-r.x)/l));if(a>c)return o;let d=s.left,f=e-s.right;if(n===0)a=d;else{let p=(d+f)/2,y=Math.max(c-p,p-a);a=p-y,c=p+y}let u=Math.max(0,a-s.left),m=Math.min(e,c+s.right);return{left:t+u,width:m-u}}function rl(t,e){if(t===null)return e;let r=Math.min(t.x,e.x),i=Math.min(t.y,e.y);return{x:r,y:i,width:Math.max(t.x+t.width,e.x+e.width)-r,height:Math.max(t.y+t.height,e.y+e.height)-i}}function Re(t,e,r){return t-e+r}function is(t,e,r,i,s){let{stageHeight:n,gap:o}=s,l=t.indexOf("current"),a=l>=0?n-r[l].height:n,c=t.map((f,u)=>{let{height:m}=r[u];switch(f){case"current":return{y:a,visible:!0};case"previous":return{y:a-o-m,visible:!0};case"queued":return{y:Re(n,m,o),visible:!1};case"gone":return{y:i[u]??a,visible:!1}}}),d=null;return t.forEach((f,u)=>{let{kind:m}=e[u];if(f!=="current"&&f!=="previous"||m==="instrumental"||m==="blank")return;let{height:p,left:y,width:S,originX:h}=r[u],g=s.activeScale;d=rl(d,{x:y+S*h*(1-g),y:c[u].y+p*(1-g)/2,width:S*g,height:p*g})}),{placements:c,box:d}}var ss={durationMs:380,easing:"cubic-bezier(0.2, 0, 0, 1)"},zt="--blyrics-stage-opacity",il=300,ns=70,sl=220,os="blur(3px)",nl=.32,ol=1,ll=3,al={height:0,left:0,width:0,originX:0},ls=new WeakSet;function as(t,e,r){let i=t.lyricsContainer;if(!i)return;dl(t);let{elements:s,items:n}=fs(t),o=es(n,e),l=o.join(",");if(l===t.stageKey&&!r)return;t.stageKey=l;let a=t.stageRemeasured;t.stageRemeasured=!1;let c=s.map(h=>t.stageMetrics.get(h)??al),d={stageHeight:i.clientHeight,gap:t.stageFontSize*nl,activeScale:ae(t,i,"--blyrics-active-scale",1)},f=a&&t.stageHeight>0?d.stageHeight-t.stageHeight:0;t.stageHeight=d.stageHeight;let u=s.map(h=>{let g=t.stageY.get(h);return g===void 0?null:g+f}),{placements:m,box:p}=is(o,n,c,u,d),y=cl(t,s,o,m,c,d,{remeasured:a,instant:r}),S=t.window.matchMedia(Y).matches;s.forEach((h,g)=>{h.dataset.stageRole!==o[g]&&(h.dataset.stageRole=o[g])});for(let h of y)ul(t,h,r,S);gl(p,t.stageBox)||(t.stageBox=p,t.host.onStageLayout?.(p))}function cl(t,e,r,i,s,n,{remeasured:o,instant:l}){let a=[];return e.forEach((c,d)=>{let f=i[d],u=c.dataset.stageRole,m=t.stageY.get(c),p=u!==void 0&&ms(u),y=f.visible||c.dataset.stageVisible!==void 0;if(o&&!l&&y&&u===r[d]){m!==f.y&&cs(t,c,f.y);return}if(m!==void 0&&p===f.visible&&(!f.visible||m===f.y)&&!l)return;let h=u==="queued"&&f.visible;a.push({element:c,placement:f,wasVisible:p,fromY:h?Re(n.stageHeight,s[d].height,n.gap):pl(t,c,m??f.y),fromOpacity:Number(t.window.getComputedStyle(c).opacity)||0})}),a}function ul(t,{element:e,placement:r,wasVisible:i,fromY:s,fromOpacity:n},o,l){t.stageMoves.get(e)?.cancel(),t.stageFades.get(e)?.cancel(),t.stageMoves.set(e,e.animate([{translate:`0 ${s}px`},{translate:`0 ${r.y}px`}],{duration:o||l?0:ss.durationMs,easing:ss.easing,fill:"forwards"}));let a=r.visible,c=o?0:a?il:sl,d=a&&!o?ns:0;a?e.dataset.stageVisible="":c===0&&delete e.dataset.stageVisible;let f=e.animate([{[zt]:n},{[zt]:a?1:0}],{duration:c,delay:d,easing:a?"ease-out":"ease",fill:"both"});if(!a&&c>0&&(f.onfinish=()=>{t.stageFades.get(e)===f&&delete e.dataset.stageVisible}),t.stageFades.set(e,f),t.stageY.set(e,r.y),t.stageBlurs.get(e)?.cancel(),t.stageBlurs.delete(e),c===0||l||i===a)return;let u=a?[os,"none"]:["none",os];t.stageBlurs.set(e,e.animate(u.map(m=>({filter:m})),{duration:c,delay:a?ns:0,easing:a?"ease-out":"ease",composite:"add",fill:a?"backwards":"forwards"}))}function cs(t,e,r){t.stageMoves.get(e)?.cancel(),t.stageMoves.set(e,e.animate([{translate:`0 ${r}px`}],{duration:0,fill:"forwards"})),t.stageY.set(e,r)}function dl(t){let e=t.window.CSS;if(!(ls.has(t.window)||typeof e?.registerProperty!="function")){ls.add(t.window);try{e.registerProperty({name:zt,syntax:"<number>",inherits:!1,initialValue:"0"})}catch(r){t.host.log("Stage opacity property was already registered",r)}}}function us(t){t.stageMetrics.clear();let e=t.lyricsContainer;if(!e)return;t.stageFontSize=Number.parseFloat(t.window.getComputedStyle(e).fontSize)||16;let r=t.document.createRange();for(let i of fs(t).elements){let s=t.window.getComputedStyle(i),n=yl(s.textAlign),o={left:Number.parseFloat(s.paddingLeft)||0,right:Number.parseFloat(s.paddingRight)||0},l=ke(t,r,i,ps(i,s),[]),a=rs(i.offsetLeft,i.offsetWidth,i.getBoundingClientRect(),l,o,n);t.stageMetrics.set(i,{height:i.offsetHeight,left:a.left,width:a.width,originX:n})}Ne(t),t.stageRemeasured=!0}function ds(t,e,r){for(let[i,s]of r)fl(t,s.lyricElement,i.lyricElement);for(let i of e)ml(t,i.lyricElement);Ne(t)}function fl(t,e,r){let i=e.dataset.stageRole,s=t.stageY.get(e);if(i===void 0||s===void 0)return;r.dataset.stageRole=i,e.dataset.stageVisible!==void 0&&(r.dataset.stageVisible="");let n=Oe(t.stageMoves.get(e),r);n===null?cs(t,r,s):(t.stageMoves.set(r,n),t.stageY.set(r,s));let o=ms(i),l=Oe(t.stageFades.get(e),r)??r.animate([{[zt]:o?1:0}],{duration:0,fill:"forwards"});o||(l.onfinish=()=>{t.stageFades.get(r)===l&&delete r.dataset.stageVisible}),t.stageFades.set(r,l);let a=Oe(t.stageBlurs.get(e),r);a!==null&&t.stageBlurs.set(r,a)}function ml(t,e){for(let r of[t.stageMoves,t.stageFades,t.stageBlurs])r.get(e)?.cancel(),r.delete(e);t.stageY.delete(e),t.stageMetrics.delete(e)}function Ie(t){for(let e of[t.stageMoves,t.stageFades,t.stageBlurs]){for(let r of e.values())r.cancel();e.clear()}t.stageMetrics.clear(),t.stageY.clear(),Ne(t),t.stageHeight=0,t.stageBox!==null&&(t.stageBox=null,t.host.onStageLayout?.(null))}function pl(t,e,r){let i=Number.parseFloat(t.window.getComputedStyle(e).translate.split(" ")[1]??"");return Number.isFinite(i)?i:r}function Ne(t){t.stageKey=""}function Oe(t,e){let r=t?.effect;if(!t||typeof r?.getKeyframes!="function"||t.playState==="finished"||t.playState==="idle")return null;let i=e.animate(r.getKeyframes(),{...r.getTiming(),composite:r.composite});return i.playbackRate=t.playbackRate,i.currentTime=t.currentTime,t.playState==="paused"&&i.pause(),i}function fs(t){let e=[],r=[],i=0;for(let n of t.lines){let o=n.time+n.duration;i=Math.max(i,o),e.push(n.lyricElement),r.push({kind:hl(n.lyricElement),start:n.time,end:o})}let s=t.lyricsContainer?.querySelector(`:scope > .${P}`);return s&&(e.push(s),r.push({kind:"credits",start:i,end:Number.POSITIVE_INFINITY})),{elements:e,items:r}}function hl(t){return t.dataset.instrumental==="true"?"instrumental":t.dataset.blank==="true"?"blank":"line"}function ms(t){return t!=="queued"&&t!=="gone"}function gl(t,e){return t===null||e===null?t===e:t.x===e.x&&t.y===e.y&&t.width===e.width&&t.height===e.height}function yl(t){return t==="center"?.5:t==="right"||t==="end"?1:0}function ps(t,e){let r=(Number.parseFloat(e.paddingLeft)||0)+(Number.parseFloat(e.paddingRight)||0);return t.clientWidth-r}function bl(t,e){return t.offsetWidth>=e-1}function ke(t,e,r,i,s){for(let n of r.childNodes){if(n.nodeType===ll){e.selectNodeContents(n),s.push(...e.getClientRects());continue}if(n.nodeType!==ol)continue;let o=n,l=t.window.getComputedStyle(o);l.display!=="none"&&(l.display==="contents"?ke(t,e,o,i,s):l.display.startsWith("inline")?s.push(...o.getClientRects()):bl(o,i)?ke(t,e,o,ps(o,l),s):s.push(o.getBoundingClientRect()))}return s}function hs(t){return t.lyricsContainer?(t.lyricsContainer.replaceChildren(),Ie(t),!0):!1}function vt(t){return t.lines}function gs(t){return t.syncType}function ys(t){t.scrollPos=-1,O(t),rr(t),at(t),t.lineCullObserver?.disconnect(),t.lineCullObserver=null,Lt(t);for(let e of t.lines)I(e),e.isSelected=!1;t.skipScrollsDecayTimes=[],t.lastScrollElements=[],t.pinnedScrollLine=null,t.lastScrollDebugContext.activeElms=[],t.lastScrollDebugContext.centers=[],t.passiveScrollAccumulatedTime=0,t.passiveLastWallTime=0,t.passiveScrollTop=null,ot(t),t.lines=[],t.cachedFooterItem=null,t.cachedCreditsItem=null,t.creditsFocused=!1,t.lyricsContainer=null,t.waveAnimationPool.length=0,Ie(t)}function bs(t,e,r,i){for(let[a,c]of i)Sl(a,c);O(t);let s=new Set(r.map(a=>a.lyricElement));for(let a of s)ee(t,a);for(let a of r)I(a),a.isSelected=!1,t.visibleWillChangeElements.delete(a.lyricElement),t.culledLineElements.delete(a.lyricElement);let n=new Map;for(let[a,c]of i)n.set(c,a);let o=a=>n.get(a)??(s.has(a.lyricElement)?null:a),l=a=>a.map(o).filter(c=>c!==null);t.lastScrollElements=l(t.lastScrollElements),t.lastScrollDebugContext.activeElms=l(t.lastScrollDebugContext.activeElms),t.pinnedScrollLine=t.pinnedScrollLine===null?null:o(t.pinnedScrollLine),t.lines=e,t.layout==="stage"&&ds(t,r,i)}function Sl(t,e){t.isScrolled=e.isScrolled,t.isSelected=e.isSelected,J(t,pt,e.lyricElement.classList.contains(pt)),J(t,V,e.lyricElement.classList.contains(V))}function Ss(t,e,r){let i=t.lyricsContainer,s=t.host.getScrollElement();if(i===null||s===null||t.layout==="stage")return;let n=Date.now(),o=wl(t,e,r,n),l=o===void 0?void 0:e.get(o)?.position;if(o!==void 0&&l!==void 0&&Kt(l)&&Kt(o.position)){let c=o.position-l;Math.abs(c)>=At&&(s.scrollTop=r+c)}let a=s.scrollTop-r;if(a!==0&&(ge(t,n),t.scrollPos>=0&&(t.scrollPos+=a)),!!_e(t,i))for(let c of t.lines){let d=e.get(c);if(d===void 0||!Kt(d.position)||!Kt(c.position))continue;let f=d.position+d.motionOffset-c.position+a;Math.abs(f)>=At&&Yt(t,c.lyricElement,f)}}function wl(t,e,r,i){return t.scrollResumeTime>i?t.lines.find(n=>{let o=e.get(n);return o!==void 0&&o.position+o.height>r}):t.lastScrollElements.findLast(n=>e.has(n))??t.lines.find(n=>e.has(n)&&n.isScrolled)}function Kt(t){return t>=0}var El=v("blyrics-target-scroll-pos-ratio",.37),Pe={top:0,bottom:0};function De(t,e){let r=Number.parseFloat(H(t,e,"--blyrics-target-scroll-pos-ratio",""));return Number.isFinite(r)?R(r,0,1):El.getNumberValue()}function Ls(t,e){t.tabRendererResizeObserver?.disconnect(),t.tabRendererResizeObserver=new t.window.ResizeObserver(()=>{O(t),e.isConnected&&Xt(t,e)}),t.tabRendererResizeObserver.observe(e),t.observedTabRenderer=e,Xt(t,e)}function Xt(t,e){let r=e.getBoundingClientRect().height,{scrollPaddingTop:i,scrollPaddingBottom:s}=t.window.getComputedStyle(e);t.cachedTabRendererHeight=r,t.cachedScrollInsets=Ll(i,s,r)}function Ll(t,e,r){let i=ws(t,r),s=ws(e,r);return i+s<r?{top:i,bottom:s}:Pe}function ws(t,e){let r=Number.parseFloat(t);return!Number.isFinite(r)||r<=0?0:t.trim().endsWith("%")?e*r/100:r}function Ts(t,e){return t.findLast(i=>i.time<=e&&e<i.time+i.duration)??t.findLast(i=>i.time<=e)??t[0]}function As(t,e,r,i,s){let n=t[0],o=t[t.length-1],l=r-i.bottom,a=(u,m)=>Math.min(Math.max(u,m.position+m.height-l),m.position-i.top),c=t.reduce((u,m)=>u+m.position+m.height/2,0)/t.length,d=a(c-s,o),f=Math.min(d,n.position-i.top);return{scrollTop:a(f,e),overflowsBand:o.position+o.height-n.position>l-i.top}}function Tl(t){let{viewportHeight:e,targetScrollRatio:r,lastLineCentre:i}=t,s=t.contentHeightWithoutBottomPadding,n=e*(1-r),o=Math.max(0,e*r-t.firstLineHeight/2),l=(i===null?e:i+n)-s,a=e-s,c=n-(t.footerHeight+t.lastLineHeight/2),d=Math.max(l,a,c,0);return{top:o,bottom:Math.ceil(d)}}function vs(t){let e=t.lyricsContainer,r=t.host.getScrollElement();if(!e||!r)return;if(yt(t)){Es(t,e,{top:0,bottom:0});return}let i=c=>c?X(e,c):null,s=c=>e.querySelector(`:scope > .${c}`),n=e.querySelectorAll(`:scope > .${Dt}`),o=i(s(P)),l=o&&o.height>0?o:i(n[n.length-1]??null),a=Number.parseFloat(t.window.getComputedStyle(e).paddingBottom)||0;Es(t,e,Tl({viewportHeight:r.getBoundingClientRect().height,targetScrollRatio:De(t,e),contentHeightWithoutBottomPadding:Math.max(0,e.scrollHeight-a),firstLineHeight:i(n[0]??null)?.height??0,lastLineCentre:l?l.y+l.height/2:null,lastLineHeight:l?.height??0,footerHeight:i(s(Ft))?.height??0}))}function Es(t,e,{top:r,bottom:i}){let s=t.document.documentElement.style;s.setProperty("--blyrics-padding-top",`${r}px`),s.setProperty("--blyrics-padding-bottom",`${i}px`),e.style.setProperty("padding-bottom",`${i}px`)}var Cs=.5/255;function Ms(t,e,r,i){let s=H(t,e,`--blyrics-highlight-glow-filter-${r}`,"");return s||`drop-shadow(0 0 ${H(t,e,`--blyrics-highlight-glow-radius-${r}`,i)} var(--blyrics-glow-color))`}function _s(t){let e=t.trim();if(e===""||e==="none")return!0;let r=e.match(/^drop-shadow\(\s*0\s+0\s+(\S+)\s+var\(--blyrics-glow-color\)\)$/);return r?Number.parseFloat(r[1])===0:!1}function Rs(t,e,r){if(r.highlight.glowContainerAlpha>=Cs){for(let s of e.parts)s.glowSuppressed=!1;return}for(let s of e.parts){let n=t.window.getComputedStyle(s.highlightElement).getPropertyValue("--blyrics-glow-color"),o=Fe(n)??1;s.glowSuppressed=o<Cs}}function Fe(t){let e=t.trim().toLowerCase();if(e==="")return null;if(e==="transparent")return 0;let r=e.match(/\/\s*([0-9]*\.?[0-9]+%?)\s*\)\s*$/);if(r)return xs(r[1]);let i=e.match(/^(?:rgba|hsla)\([^)]*,\s*([0-9]*\.?[0-9]+%?)\s*\)$/);if(i)return xs(i[1]);let s=e.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/);if(s){let a=s[1],c=a.length===8?a.slice(6):a.slice(3).repeat(2);return Number.parseInt(c,16)/255}let n=/^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(/.test(e),o=/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(e),l=/^[a-z]+$/.test(e);return n||o||l?1:null}function xs(t){let e=t.endsWith("%")?Number.parseFloat(t)/100:Number.parseFloat(t);return R(e,0,1)}var We="M -4 3 Q 1 2 5 3 Q 10 4 14 3 Q 18 2 22 3 Q 26 4 30 3 L 30 4 L -4 4 Z",Os="M -4 3 Q 1 4 5 3 Q 10 2 14 3 Q 18 4 22 3 Q 26 2 30 3 L 30 4 L -4 4 Z",Al=0;function ks(t,e,r){e.classList.add("blyrics--instrumental"),e.style.setProperty("--blyrics-duration",`${r}ms`);let i="http://www.w3.org/2000/svg",s=t.createElementNS(i,"svg");s.classList.add("blyrics--instrumental-icon"),s.setAttribute("viewBox","0 0 24 24");let n=t.createElementNS(i,"defs"),o=Al++,l=`blyrics-glow-${o}`,a=`blyrics-wave-clip-${o}`,c=t.createElementNS(i,"filter");c.setAttribute("id",l),c.setAttribute("x","-100%"),c.setAttribute("y","-100%"),c.setAttribute("width","300%"),c.setAttribute("height","300%");let d=t.createElementNS(i,"feGaussianBlur");d.setAttribute("in","SourceGraphic"),d.setAttribute("stdDeviation","5"),d.setAttribute("result","blur"),c.appendChild(d);let f=t.createElementNS(i,"feColorMatrix");f.setAttribute("in","blur"),f.setAttribute("type","matrix"),f.setAttribute("values","1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0.6 0"),f.setAttribute("result","fadedBlur"),c.appendChild(f);let u=t.createElementNS(i,"feMerge"),m=t.createElementNS(i,"feMergeNode");m.setAttribute("in","fadedBlur"),u.appendChild(m);let p=t.createElementNS(i,"feMergeNode");p.setAttribute("in","SourceGraphic"),u.appendChild(p),c.appendChild(u),n.appendChild(c);let y=t.createElementNS(i,"clipPath");y.setAttribute("id",a),y.classList.add("blyrics--wave-clip");let S=t.createElementNS(i,"path");S.classList.add("blyrics--wave-rect"),S.setAttribute("d","M -4 3.9 L 30 3.9 L 30 30 L -4 30 Z"),y.appendChild(S);let h=t.createElementNS(i,"path");h.classList.add("blyrics--wave-path"),h.setAttribute("d",We),y.appendChild(h),n.appendChild(y),s.appendChild(n);let g=t.createElementNS(i,"path");g.classList.add("blyrics--instrumental-bg"),g.setAttribute("d","M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V4q0-.425.288-.712T13 3h4q.425 0 .713.288T18 4v2q0 .425-.288.713T17 7h-3v10q0 1.65-1.175 2.825T10 21"),s.appendChild(g);let w=t.createElementNS(i,"g");w.setAttribute("filter",`url(#${l})`);let T=t.createElementNS(i,"path");if(T.classList.add("blyrics--instrumental-fill"),T.setAttribute("clip-path",`url(#${a})`),T.setAttribute("d","M10 21q-1.65 0-2.825-1.175T6 17t1.175-2.825T10 13q.575 0 1.063.138t.937.412V4q0-.425.288-.712T13 3h4q.425 0 .713.288T18 4v2q0 .425-.288.713T17 7h-3v10q0 1.65-1.175 2.825T10 21"),lt.getBooleanValue()){T.classList.remove("blyrics--instrumental-fill"),T.classList.add("blyrics-instrumental-color");let b=t.createElementNS(i,"g");b.classList.add("blyrics--instrumental-fill"),b.appendChild(T);let E=`${a}-image-shape`,A=t.createElementNS(i,"clipPath");A.setAttribute("id",E);let _=t.createElementNS(i,"path");_.setAttribute("d",T.getAttribute("d")),A.appendChild(_),n.appendChild(A);let L=t.createElementNS(i,"g");L.setAttribute("clip-path",`url(#${E})`);let C=t.createElementNS(i,"g");C.setAttribute("clip-path",`url(#${a})`);let k=t.createElementNS(i,"image");k.classList.add("blyrics-instrumental-image"),k.setAttribute("x","0"),k.setAttribute("y","0"),k.setAttribute("width","24"),k.setAttribute("height","24"),k.setAttribute("preserveAspectRatio","none"),C.appendChild(k),L.appendChild(C),b.appendChild(L),w.appendChild(b),c.setAttribute("color-interpolation-filters","sRGB"),d.setAttribute("stdDeviation","1"),c.removeChild(f),m.setAttribute("in","blur")}else w.appendChild(T);return s.appendChild(w),e.appendChild(s),e}var Ct=new WeakMap;function ct(t,e,r){return Ct.set(e,{...r,appliedTimingOffsetMs:r.appliedTimingOffsetMs??t.learnedAnimationTimingOffsetMs}),e.playbackRate=t.playbackRate,e}function He(t,e){let r=t.sweepContext?.host;if(!r)return[];let i=[];for(let s of e){let n=s.effect;if(!n||n.target!==t.highlightElement)continue;let o=r.animate(n.getKeyframes(),n.getTiming());o.playbackRate=s.playbackRate,o.currentTime=s.currentTime;let l=Ct.get(s);l&&Ct.set(o,{...l,skipDriftSample:!0}),i.push(o)}return i}function Ps(t){let e=r=>{for(let i of r)Ct.has(i)&&(i.playbackRate=t.playbackRate)};for(let r of t.lines){e(r.animations);for(let i of r.parts)e(i.animations)}}function ut(t,e,r){let i=t-e;return r===void 0?i:Math.min(i,r)}function Ds(t,e,r){return Mt(t-e,r)}function Fs(t,e){return e-t.learnedAnimationTimingOffsetMs/1e3}function Ws(t,e){let r=Is(t,e,null);for(let i of t.parts)r=Is(i,e,r);return r}function Is(t,e,r){for(let i of t.animations){let s=vl(t,i,e);s&&(!r||Math.abs(s.offsetMs)>Math.abs(r.offsetMs))&&(r=s)}return r}function vl(t,e,r){let i=Ct.get(e);if(!i||i.skipDriftSample||e.playState==="idle")return null;let s=Hs(e.currentTime);if(s===null)return null;let n=Ns(e,(r-t.time)*1e3+i.offsetMs,i),o=Ns(e,s,i);if(n===null||o===null)return null;let l=i.wrapDurationMs??0,a=l>0?Cl(o,n,l):o-n;return{actualTimeMs:o,appliedTimingOffsetMs:i.appliedTimingOffsetMs,biasOffsetMs:a+i.appliedTimingOffsetMs,expectedTimeMs:n,offsetMs:a,playState:e.playState}}function Ns(t,e,r){if(!Number.isFinite(e)||e<0)return null;if(r.wrapDurationMs&&r.wrapDurationMs>0)return Mt(e,r.wrapDurationMs);let i=Hs(t.effect?.getComputedTiming().endTime);return i!==null&&Number.isFinite(i)?Math.min(e,i):e}function Cl(t,e,r){return Mt(t-e+r/2,r)-r/2}function Hs(t){if(typeof t=="number")return Number.isFinite(t)||t===Number.POSITIVE_INFINITY?t:null;if(typeof t=="string"){let r=K(t);return r>0?r:null}let e=t;if(typeof e?.to!="function")return null;try{let r=e.to("ms").value;return typeof r=="number"&&Number.isFinite(r)?r:null}catch{return null}}var Vs=".blyrics--instrumental-fill",xl=".blyrics--wave-clip",Gs=".blyrics--wave-path",Bs=1,Us=`path("${We}")`,$s=`path("${Os}")`;function Ys(t,e,r,i,s){let n=(i-e.time)*1e3,o=Math.max(e.duration*1e3,1),l=r.enabled.instrumental,{instrumental:a}=r,c=(h,g,w)=>{h&&(ct(t,h,{appliedTimingOffsetMs:s,offsetMs:0,wrapDurationMs:w}),h.currentTime=g)},d=h=>ut(n,s,h),f=l?a.fillFadeDurationMs:Bs,u=qt(e,Vs,[{opacity:0},{opacity:1}],{duration:f,easing:l?a.fillFadeEasing:"linear",fill:"forwards"});if(c(u,d(f)),!l)return;let m=(h,g,w,T)=>qt(e,h,[{transform:g},{transform:w}],{duration:o,easing:T,fill:"both"});c(m(xl,a.fillFrom,a.fillTo,a.fillEasing),d(o)),c(m(Gs,a.waveFrom,a.waveTo,a.waveEasing),d(o));let p=a.waveOscillationDurationMs,y=qt(e,Gs,[{d:a.wavePathHigh},{d:a.wavePathLow,offset:.5},{d:a.wavePathHigh}],{duration:p,easing:a.waveOscillationEasing,iterations:1/0}),S=Math.max(p,1);c(y,Ds(n,s,S),p)}function zs(t,e,r){if(r<t.time)return;let i=e.enabled.instrumental&&e.enabled.highlightFade;qt(t,Vs,[{opacity:1},{opacity:0}],{duration:i?e.highlight.fadeOutDurationMs:Bs,easing:e.enabled.instrumental?e.highlight.fadeOutEasing:"linear",fill:"none"})}function qt(t,e,r,i){let s=t.lyricElement.querySelector(e);if(!s)return null;let n=s.animate(r,i);return t.animations.push(n),n}var Ml=v("blyrics-early-scroll-consider-s",.54),_l="cubic-bezier(0.86, 0, 0.2, 1)";function Ks(t,e){return t.cachedAnimationSettings??={config:Rl(t,e),scrollTiming:{earlyScrollConsiderS:Math.max(0,Ml.getNumberValue())}},t.cachedAnimationSettings}function Rl(t,e){let r=Pr(t,e),i=Ms(t,e,"to","0");return{enabled:{lineScale:r.flag("--blyrics-animate-line-scale",!0),wordWobble:r.flag("--blyrics-animate-word-wobble",!0),highlightSwipe:r.flag("--blyrics-animate-highlight-swipe",!0),highlightGlow:r.flag("--blyrics-animate-highlight-glow",!0),highlightFade:r.flag("--blyrics-animate-highlight-fade",!0),scroll:r.flag("--blyrics-animate-scroll",!0),instrumental:r.flag("--blyrics-animate-instrumental",!0)},line:{durationMs:r.durationMs("--blyrics-scale-transition-duration","0.166s"),enterEasing:r.string("--blyrics-line-enter-easing","ease"),exitEasing:r.string("--blyrics-line-exit-easing","ease"),enterFrom:r.string("--blyrics-line-enter-transform-from","scale(var(--blyrics-scale))"),enterTo:r.string("--blyrics-line-enter-transform-to","scale(var(--blyrics-active-scale))"),exitFrom:r.string("--blyrics-line-exit-transform-from","scale(var(--blyrics-active-scale))"),exitTo:r.string("--blyrics-line-exit-transform-to","scale(var(--blyrics-scale))")},highlight:{fadeInDurationMs:r.durationMs("--blyrics-lyric-highlight-fade-in-duration","0.33s"),fadeOutDurationMs:r.durationMs("--blyrics-lyric-highlight-fade-out-duration","0.5s"),fadeInEasing:r.string("--blyrics-lyric-highlight-fade-in-easing","ease"),fadeOutEasing:r.string("--blyrics-lyric-highlight-fade-out-easing","ease"),swipeEasing:r.string("--blyrics-highlight-swipe-easing","linear"),swipeStartFrom:r.string("--blyrics-highlight-swipe-start-from","-0.2"),swipeEndFrom:r.string("--blyrics-highlight-swipe-end-from","-0.1"),swipeStartTo:r.string("--blyrics-highlight-swipe-start-to","1.4"),swipeEndTo:r.string("--blyrics-highlight-swipe-end-to","1.5"),glowTo:i,glowDurationRatio:r.number("--blyrics-highlight-glow-duration-ratio",1.2),glowMinDurationMs:r.durationMs("--blyrics-highlight-glow-min-duration","1.2s"),glowEasing:r.string("--blyrics-highlight-glow-easing","ease"),glowContainerAlpha:Fe(r.string("--blyrics-glow-color",""))??1,glowRestingInvisible:_s(i)},word:{wobbleDurationMs:r.durationMs("--blyrics-wobble-duration","1s"),wobbleEasing:r.string("--blyrics-word-wobble-easing","ease"),wobblePeakEasing:r.string("--blyrics-word-wobble-peak-easing","ease-in-out"),wobbleEndEasing:r.string("--blyrics-word-wobble-end-easing","ease-out"),wobbleFrom:r.string("--blyrics-word-wobble-transform-from","scaleX(1)"),wobblePeak:r.string("--blyrics-word-wobble-transform-peak","translateX(0.05em) scaleX(1.025)"),wobbleSettle:r.string("--blyrics-word-wobble-transform-settle","translateX(0) scaleX(1)"),wobbleTo:r.string("--blyrics-word-wobble-transform-to","scaleX(1)"),wobblePeakOffset:r.fraction("--blyrics-word-wobble-peak-offset",.125),wobbleSettleOffset:r.fraction("--blyrics-word-wobble-settle-offset",.75)},letterWave:{transform:r.string("--blyrics-letter-wave-transform","translateY(-0.06em)"),settle:r.string("--blyrics-letter-wave-settle","translateY(-0.05em)"),emphasisScale:r.string("--blyrics-letter-wave-emphasis-scale","1.08"),durationMs:r.durationMs("--blyrics-letter-wave-duration","0.9s"),riseEasing:r.string("--blyrics-letter-wave-rise-easing","ease-in-out"),fallEasing:r.string("--blyrics-letter-wave-fall-easing","ease-in-out")},instrumental:{fillFadeDurationMs:r.durationMs("--blyrics-instrumental-fill-fade-duration","150ms"),fillFadeEasing:r.string("--blyrics-instrumental-fill-fade-easing","ease"),fillFrom:r.string("--blyrics-instrumental-fill-transform-from","translateY(78%)"),fillTo:r.string("--blyrics-instrumental-fill-transform-to","translateY(-4%)"),fillEasing:r.string("--blyrics-instrumental-fill-easing","linear"),waveFrom:r.string("--blyrics-instrumental-wave-transform-from","scaleY(1.2)"),waveTo:r.string("--blyrics-instrumental-wave-transform-to","scaleY(0.0001)"),waveEasing:r.string("--blyrics-instrumental-wave-easing","ease-in"),wavePathHigh:r.string("--blyrics-instrumental-wave-path-high",Us),wavePathLow:r.string("--blyrics-instrumental-wave-path-low",$s),waveOscillationDurationMs:r.durationMs("--blyrics-instrumental-wave-oscillation-duration","1.25s"),waveOscillationEasing:r.string("--blyrics-instrumental-wave-oscillation-easing","ease-in-out")},lineScroll:{easing:r.string("--blyrics-lyric-scroll-timing-function",_l),differentialEffects:!t.window.matchMedia(Y).matches}}}var Ol=v("blyrics-debug-renderer",!1),kl=40,Il=1e3,Nl=160;function qs(){return Ol.getBooleanValue()}function js(t,e){let r=t.window.getComputedStyle(e.lyricsElement).transform,i=e.scrollTop-new t.window.DOMMatrix(r).f,s=t.host.debug?.beginFrame(i);if(!s)return;let n=(l,a,c)=>{s.strokeStyle=l,s.fillStyle=l,s.fillText(a,0,c),s.beginPath(),s.moveTo(kl,c),s.lineTo(Il,c),s.stroke()};n("green","visible top",e.scrollTop),n("blue","visible bottom",e.scrollTop+e.viewportHeight),n("yellow","target",e.scrollTop+e.targetOffset);let o=t.lastScrollDebugContext;Xs(s,i,0,"realtime",e.followedLines,e.lineCenters,e.scrollTimeS,e),Xs(s,i,Nl,"last scroll",o.activeElms,o.centers,o.lyricScrollTime,e)}function Xs(t,e,r,i,s,n,o,{endingThresholdS:l}){t.strokeStyle="red",t.fillStyle="red",t.fillText(i,r+2,e+45),t.fillText(`scroll time: ${o.toFixed(3)}`,r+2,e+60);for(let a of s){let c=a.time-o,d=a.time+a.duration,f=d-o,u=f<l?"gray":c>0?"magenta":"orange";t.strokeStyle=u,t.fillStyle=u,t.beginPath(),t.moveTo(r+5,a.position),t.lineTo(r+5,a.position+a.height),t.stroke(),t.fillText(`time: start=${a.time.toFixed(2)} end=${d.toFixed(2)}`,r+15,a.position),t.fillText(`till active: ${c.toFixed(2)}`,r+15,a.position+15),t.fillText(`till end: ${f.toFixed(2)}`,r+15,a.position+30)}t.strokeStyle="pink",t.fillStyle="pink";for(let a of n)t.beginPath(),t.arc(r+5,a,5,0,2*Math.PI,!1),t.fill()}var Pl=v("blyrics-lyric-ending-threshold-s",.5),Qs=2;function Zs(t){let{engine:e,lyricsElement:r,now:i}=t;Dl(e,i)&&Fl(t),e.wasUserScrolling&&e.scrollResumeTime<i&&(e.host.setResumeAffordanceVisible(!1),r.classList.remove(st),e.wasUserScrolling=!1),gi(e,i,!t.countEveryUserScroll)}function Dl(t,e){return t.scrollResumeTime<e||t.scrollPos===-1}function Ge(t){return t.lines.findLast(e=>e.lyricElement.dataset.instrumental!=="true")}function Fl(t){let{engine:e,lyricsElement:r,scroller:i,scrollTimeS:s,config:n,smoothScroll:o,jumped:l}=t,a=t.focusedLines.length>0?t.focusedLines:e.lines.slice(0,1),c=a.at(-1);if(!c)return;let d=i.height*De(e,r),f=Pl.getNumberValue(),u=a.filter(C=>C===c||s<C.time+C.duration-f),m=u.map(C=>C.position+C.height/2),p=Ts(u,s),y=As(u,p,i.height,e.cachedScrollInsets,d),S=R(Wl(e,y.scrollTop,d),0,i.maxScrollTop);qs()&&js(e,{lyricsElement:r,scrollTop:i.scrollTop,viewportHeight:i.height,targetOffset:d,followedLines:a,lineCenters:m,scrollTimeS:s,endingThresholdS:f});let h=e.pinnedScrollLine,g=h!==null&&h!==p&&(!u.includes(h)||s>=h.time+h.duration),w=t.focusChanged||g||e.wasUserScrolling,T=i.scrollTop,b=Math.abs(S-T)>Qs,E=o&&n.enabled.scroll,A=()=>({lines:Nr(e,e.lines),activeLine:c,fromScrollTop:T,toScrollTop:S,viewportHeight:i.height,config:n,continuesEngineScroll:!l&&!e.wasUserScrolling&&e.scrollPos>=0&&Math.abs(T-e.scrollPos)<=Qs}),_=(c.time-s)*1e3,L=_>0&&_<=Ar;E&&b&&!w&&L&&!e.lastScrollElements.includes(c)&&(Tt(e,e.lines,T,S,i.height),xr(e,A())),w&&(e.lastScrollElements=a,e.pinnedScrollLine=y.overflowsBand?p:null,e.lastScrollDebugContext={lyricScrollTime:s,centers:m,activeElms:a},o&&b?n.enabled.scroll&&(Tt(e,e.lines,T,S,i.height),Cr(e,A())):O(e),pi(e,i.element,S,t.now))}function Wl(t,e,r){let i=t.cachedCreditsItem,s=Ge(t);if(!t.creditsFocused||!i||!s)return e;let n=i.position+i.height/2-r,o=s.position-t.cachedScrollInsets.top;return Math.min(n,o)}var jt=v("blyrics-debug-animation-timing",!1),Js=3e3,Hl=750,Gl=30,tn=new WeakMap;function Ve(t,e,r,i){return!jt.getBooleanValue()||!(i<t.animationTimingVisibilityLogUntil)&&Math.abs(r.offsetMs)<Gl||i-(tn.get(e)??0)<Hl?!1:(tn.set(e,i),!0)}function Qt(t,e,r,i,s,n,o,l=t.learnedAnimationTimingOffsetMs){jt.getBooleanValue()&&t.host.log("WAAPI timing",{reason:e,lineIndex:i,lineTimeS:xt(r.time),mediaTimeS:xt(n),actualTimeMs:D(s.actualTimeMs),expectedTimeMs:D(s.expectedTimeMs),offsetMs:D(s.offsetMs),learnedOffsetMs:D(l),appliedTimingOffsetMs:D(s.appliedTimingOffsetMs),biasOffsetMs:D(s.biasOffsetMs),residualOffsetMs:D(s.offsetMs),accumulatedOffsetMs:D(o),playState:s.playState,text:sn(r)})}function Be(t,e,r,i,s,n){jt.getBooleanValue()&&t.host.log("Animation cleanup",{reason:e,lineIndex:i,lineTimeS:xt(r.time),mediaTimeS:xt(s),staleAnimationEndTimeS:xt(n),runningAnimationCount:rn(r),text:sn(r)})}function en(t){if(!jt.getBooleanValue()||!t.lyricsContainer)return;let e=t.document.visibilityState,r=t.lines.reduce((i,s)=>i+rn(s),0);if(e!=="visible"){t.host.log("Visibility changed; WAAPI animations left intact",{visibilityState:e,runningAnimationCount:r,resetSkipped:!0});return}t.animationTimingVisibilityLogUntil=Date.now()+Js,t.host.log("Visibility changed; keeping WAAPI animations for timing verification",{visibilityState:e,runningAnimationCount:r,resetSkipped:!0,timingLogWindowMs:Js})}function rn(t){return t.parts.reduce((e,r)=>e+r.animations.length,t.animations.length)}function xt(t){return D(t*1e3)/1e3}function sn(t){return t.lyricElement.textContent?.trim().replace(/\s+/g," ").slice(0,80)??""}var Vl=.08,Bl=80,nn=80,Ul=1.08,$l=.4,Yl=500;function on({engine:t,line:e,lineIndex:r,lyricTimeS:i,isPlaying:s,now:n}){let o=Ws(e,i);if(e.accumulatedOffsetMs/=Ul,o===null)return;if(!zl(o,s)){Ve(t,e,o,n)&&Qt(t,"ignored-sample",e,r,o,i,e.accumulatedOffsetMs);return}let l=Kl(t,o);if(e.accumulatedOffsetMs+=o.offsetMs*$l,Ve(t,e,o,n)){let c=e.accumulatedOffsetMs;Qt(t,"sample",e,r,o,i,c,l)}let a=Math.abs(e.accumulatedOffsetMs)>Yl;e.isAnimating&&s&&a&&(Qt(t,"drift-reset",e,r,o,i,e.accumulatedOffsetMs),I(e))}function zl(t,e){return e&&(t.playState==="running"||t.playState==="finished")}function Kl(t,e){if(Math.abs(e.biasOffsetMs)>Bl)return t.learnedAnimationTimingOffsetMs;let r=t.learnedAnimationTimingOffsetMs;return t.learnedAnimationTimingOffsetMs=R(r+(e.biasOffsetMs-r)*Vl,-nn,nn),t.learnedAnimationTimingOffsetMs}var Xl=v("blyrics-swipe-lead-ratio",.1),ql=v("blyrics-swipe-duration-ratio",1.6),jl="blyrics-line-synced-word",Zt=1,Ql=[{opacity:1},{opacity:1}],Zl=[{opacity:0},{opacity:1}],Jl=[{opacity:1},{opacity:0}],ln=new WeakMap;function an(t,e,r,i,s){N(e);let n=ea(t,e,r,i,s),o=e.lyricElement.classList.contains(jl)?ia(n):ra(n),l=r.enabled.wordWobble?[...ca(n),...ua(n)]:[];e.animations=[...o,...He(e,o),...l]}function cn(t,e){let r=t.animations.filter(o=>ta(o));t.animations=t.animations.filter(o=>!r.includes(o)),N(t);let i=e.enabled.highlightFade,s=i?e.highlight.fadeOutDurationMs:Zt,n=t.highlightElement.animate(Jl,{duration:s,easing:i?e.highlight.fadeOutEasing:"linear",fill:"none"});t.animations=[n,...He(t,[n]),...r],n.addEventListener("finish",()=>N(t),{once:!0})}function ta(t){let e=ln.get(t);return e!==void 0&&Number(t.currentTime)>=e}function ea(t,e,r,i,s){let n=Math.max(0,e.duration*1e3);return{engine:t,part:e,config:r,appliedTimingOffsetMs:s,elapsedMs:(i-e.time)*1e3,durationMs:n,swipeLeadMs:n*Xl.getNumberValue(),swipeDurationMs:n*ql.getNumberValue(),glowDurationMs:Math.max(n*r.highlight.glowDurationRatio,r.highlight.glowMinDurationMs)}}function dt(t,e,r){return ut(e,t.appliedTimingOffsetMs,r)}function et(t,e,r,{offsetMs:i=0,skipDriftSample:s=!1}={}){let{appliedTimingOffsetMs:n}=t;return ct(t.engine,e,{appliedTimingOffsetMs:n,offsetMs:i,skipDriftSample:s}),e.currentTime=r,e}function Ye(t,e){return e.enabled.highlightGlow&&!t.glowSuppressed}function ra(t){let{part:e,config:r}=t,i=r.enabled.highlightSwipe,s=i?sa(t):[],n=e.highlightElement.animate(Ql,{duration:Zt,easing:"linear",fill:"forwards"});return s.push(et(t,n,dt(t,t.elapsedMs,Zt))),Ye(e,r)&&s.push(...un(t,t.glowDurationMs,i)),s}function ia(t){let{part:e,config:r}=t,i=r.enabled.highlightFade,s=i?r.highlight.fadeInDurationMs:Zt,n=e.highlightElement.animate(Zl,{duration:s,easing:i?r.highlight.fadeInEasing:"linear",fill:"forwards"}),o=[et(t,n,dt(t,t.elapsedMs,s))];return Ye(e,r)&&o.push(...un(t,r.highlight.glowMinDurationMs,!1)),o}function sa(t){let{part:e,swipeLeadMs:r,swipeDurationMs:i}=t,s=dt(t,t.elapsedMs+r,i);return e.sweep?na(t,e.sweep,s):[]}function na(t,e,r){let{part:i,config:s,swipeLeadMs:n,swipeDurationMs:o}=t,l=i.highlightElement.classList.contains(W),a={duration:o,easing:s.highlight.swipeEasing,fill:"both"},c=[];return e.forEach((d,f)=>{let u=d.span??{start:f/e.length,width:1/e.length},m=Xi(tt(s),u,l);if(m)for(let[p,y]of[[d.mask,m.mask],[d.text,m.text]]){let S=p.animate(y,a);c.push(et(t,S,r,{offsetMs:n,skipDriftSample:c.length>0}))}}),c}function un(t,e,r){return t.part.sweep?la(t,t.part.sweep,e,r):[]}var $e=.6,oa=$e/2;function la(t,e,r,i){let{engine:s,config:n,swipeLeadMs:o,swipeDurationMs:l}=t,a=n.highlight.glowRestingInvisible,c=Ot(s)(n.highlight.glowEasing),d=tt(n);return e.flatMap((f,u)=>{let m=f.span??{start:u/e.length,width:1/e.length},p=i?Math.max(0,Yi(d,m)*l-o):0,y=i?zi(d,m)*l-o:p,S=Math.max(0,y-p),h=r>0?Math.min(c(S/r),oa):0,g={delay:p,duration:r,easing:n.highlight.glowEasing,fill:a?"none":"forwards"},w=dt(t,t.elapsedMs,p+r),T=aa(a,h);return f.glows.map((b,E)=>{let A=b.glow.animate(E===0?T.wide:T.tight,g);return ln.set(A,p),et(t,A,w,{skipDriftSample:!0})})})}function aa(t,e){let r=e>0,i=r?[{opacity:0},{opacity:1,offset:e}]:[{opacity:1}],s=r?[{opacity:0},{opacity:0,offset:e}]:[{opacity:0}];return t?{wide:[...i,{opacity:0,offset:$e},{opacity:0}],tight:[...s,{opacity:1,offset:$e},{opacity:0}]}:{wide:[...i,{opacity:1}],tight:[{opacity:0},{opacity:0}]}}function ca(t){let{wobbleFrom:e,wobblePeak:r,wobblePeakOffset:i,wobblePeakEasing:s,wobbleSettle:n,wobbleSettleOffset:o}=t.config.word,{wobbleTo:l,wobbleEndEasing:a,wobbleDurationMs:c,wobbleEasing:d}=t.config.word,f=[{transform:e},{transform:r,offset:i,easing:s},{transform:n,offset:Math.max(i,o)},{transform:l,easing:a}],u={duration:c,easing:d,fill:"forwards"},m=dt(t,t.elapsedMs,c);return t.part.wobbleElements.map(p=>et(t,p.animate(f,u),m))}function ua(t){let{part:e,config:r}=t,i=e.letterElements?.length??0;if(i===0)return[];let s=da(t,i),n=Ye(e,r)?e.sweep?.flatMap(l=>l.glows.map(a=>a.letters))??[]:[],o=[];Ue(t,s,e.letterElements,!0,o),Ue(t,s,e.highlightLetterElements,!1,o);for(let l of n)Ue(t,s,l,!1,o);return o}function da(t,e){let{config:r}=t,i=t.part.lyricElement.dataset.longWord==="true",s=i?` scale(${r.letterWave.emphasisScale})`:"",n=i?" scale(1)":"",o=[{transform:`translateY(0)${n}`,easing:r.letterWave.riseEasing},{transform:`${r.letterWave.transform}${s}`,offset:Ut,easing:r.letterWave.fallEasing},{transform:`${r.letterWave.settle}${n}`}],l=Ui(tt(r),e,t.durationMs,t.swipeDurationMs,t.swipeLeadMs,r.letterWave.durationMs),a=Math.max(0,-Math.min(...l.map(f=>f.delayMs))),c=l.map(f=>f.delayMs+f.durationMs),d=Math.max(...c);return{waves:l,keyframes:o,signature:JSON.stringify(o),headStartMs:a,lastEndingWaveIndex:c.lastIndexOf(d),startAtMs:dt(t,t.elapsedMs+a,a+d)}}function Ue(t,e,r,i,s){r?.forEach((n,o)=>{let l=e.waves[o],a=l.delayMs+e.headStartMs,c=yi(t.engine,n,e.keyframes,e.signature,{duration:l.durationMs,delay:a,fill:"forwards"}),d=!i||o!==e.lastEndingWaveIndex;if(s.push(et(t,c,e.startAtMs,{offsetMs:e.headStartMs,skipDriftSample:d})),!Vi||!i)return;let f=n.animate(Bi,{duration:Ce,iterations:l.durationMs/Ce,delay:a,composite:"add"});s.push(et(t,f,e.startAtMs,{offsetMs:e.headStartMs,skipDriftSample:!0}))})}function dn(t,e,r,i){let s=t.learnedAnimationTimingOffsetMs;if(ze(e)||qi(e,r),fa(t,e,r,i,s),ze(e)){Ys(t,e,r,i,s);return}Rs(t,e,r);for(let n of e.parts)an(t,n,r,i,s)}function fn(t,e,r){if(ma(t,e),ze(t)){zs(t,e,r);return}for(let i of t.parts)r>=i.time?cn(i,e):N(i)}function ze(t){return t.lyricElement.dataset.instrumental==="true"}function fa(t,e,r,i,s){if(N(e),!r.enabled.lineScale)return;let{enterFrom:n,enterTo:o,enterEasing:l,durationMs:a}=r.line,c=e.lyricElement.animate([{transform:n},{transform:o}],{duration:a,easing:l,fill:"forwards"});ct(t,c,{appliedTimingOffsetMs:s,offsetMs:0});let d=(i-e.time)*1e3;c.currentTime=ut(d,s,a),e.animations=[c]}function ma(t,e){if(N(t),!e.enabled.lineScale)return;let{exitFrom:r,exitTo:i,exitEasing:s,durationMs:n}=e.line,o=t.lyricElement.animate([{transform:r},{transform:i}],{duration:n,easing:s,fill:"none"});t.animations=[o],o.addEventListener("finish",()=>N(t),{once:!0})}var pa=2,ha=.05,ga=.05;function mn(t){let{engine:e,lyricTimeS:r,playhead:i}=t,s=e.lines,n=i.isPlaying?pa:0,o=[];for(let l=0;l<s.length;l++){let a=s[l],c=s[l+1]?.time??1/0,d=Math.max(c,a.time+a.duration+ha);r+n>=a.time&&r<d?(ya(t,a,l),a.isAnimating||o.push(a)):ba(t,a,l,d)}for(let l of o)Sa(t,l)}function ya(t,e,r){let{lyricTimeS:i,playhead:s}=t;e.isSelected||(e.isSelected=!0,e.lyricElement.classList.add(V)),e.isAnimationPlayStatePlaying!==s.isPlaying&&(e.isAnimationPlayStatePlaying=s.isPlaying,Gt(e,s.isPlaying),s.isPlaying&&(e.isAnimating=!1)),(s.jumped&&s.isPlaying||s.mediaClockRanBackwards||s.seekedWhilePaused)&&e.isAnimating&&I(e),we(e,i),on({engine:t.engine,line:e,lineIndex:r,lyricTimeS:i,isPlaying:s.isPlaying,now:t.now})}function ba({engine:t,lyricTimeS:e,playhead:r,config:i},s,n,o){let l=o+i.highlight.fadeOutDurationMs/1e3+ga,a=e>l,c=s.isSelected;c?(r.isPlaying||r.jumped||r.seekedWhilePaused?a?(Be(t,"selected-stale-reset",s,n,e,l),I(s)):(fn(s,i,e),Se(s)):(Gt(s,!1),s.isAnimationPlayStatePlaying=!1),s.isSelected=!1,wi(s)):Si(s)&&(r.jumped||a)&&(Be(t,r.jumped?"time-jump-reset":"stale-reset",s,n,e,l),I(s)),(c||r.jumped)&&we(s,e)}function Sa({engine:t,lyricTimeS:e,playhead:r,config:i,now:s},n){dn(t,n,i,e),n.isAnimating=!0,n.lastAnimSetupAt=s,n.isAnimationPlayStatePlaying=r.isPlaying,n.accumulatedOffsetMs=0,r.isPlaying||Gt(n,!1)}var wa="No lyrics element found on the page, skipping lyrics injection",Ea="Error in lyrics tick:";function Ke(t){return{isPlaying:t.isPlaying,eventCreationTime:t.eventCreationTime??j,smoothScroll:t.smoothScroll??!0,globalLyricOffset:t.globalLyricOffset??0,lyricOffset:t.lyricOffset??0,richsyncOffsetTrim:t.richsyncOffsetTrim??0,lineOffsetTrim:t.lineOffsetTrim??0,passiveScrollEnabled:t.passiveScrollEnabled??!1,playbackRate:La(t.playbackRate),followPausedSeeks:t.followPausedSeeks??!1,countEveryUserScroll:t.countEveryUserScroll??!1}}function La(t){return t!==void 0&&Number.isFinite(t)&&t>0?t:1}function Jt(t,e,r){if(Ta(t,r),e===0&&!r.isPlaying)return"ok";if(yt(t))return ot(t),"ok";if(bt(t))return Aa(t,r),"ok";let i=Date.now(),s=Fr(e,r,t.playbackRate,i);if(s.jumped&&O(t),!t.host.isViewVisible())return at(t),"ok";if(t.host.syncAdState())return"ok";let n=t.lyricsContainer;if(!n)return t.host.log(wa),"lyrics-missing";try{Ca(t,n,s,r,i)}catch(o){va(o)||t.host.log(Ea,o)}return"ok"}function Ta(t,e){t.lastTickOptions=e,t.passiveScrollEnabled=e.passiveScrollEnabled,t.playbackRate!==e.playbackRate&&(t.playbackRate=e.playbackRate,Ps(t))}function Aa(t,{isPlaying:e,passiveScrollEnabled:r}){t.layout!=="stage"&&(e&&!M.lastPlayState&&(t.scrollResumeTime=0),M.lastPlayState=e,r&&ai(t))}function va(t){return t.message?.includes("undefined")??!1}function Ca(t,e,r,i,s){let n=r.timeS+ce(t,e,i),o=Fs(t,n)+mt(t,e,"--blyrics-scroll-timing-offset")/1e3,{config:l,scrollTiming:a}=Ks(t,e),c=t.layout==="stage",d=c?null:xa(t);if(!c&&!d){at(t);return}if(d&&l.enabled.scroll){let m=t.pendingLineScroll?.toScrollTop??d.scrollTop;Tt(t,t.lines,d.scrollTop,m,d.height)}else Ma(t);let f=_a(t,o,a.earlyScrollConsiderS);mn({engine:t,lyricTimeS:n,playhead:r,config:l,now:s});let u=Oa(t,e,o);if(!d){as(t,n,r.jumped);return}Zs({engine:t,lyricsElement:e,scroller:d,focusedLines:f.lines,scrollTimeS:o,config:l,smoothScroll:i.smoothScroll,countEveryUserScroll:i.countEveryUserScroll,jumped:r.jumped,focusChanged:r.jumped||f.reachedUncommittedLine||u,now:s})}function xa(t){let e=t.host.getScrollElement();return e?(e!==t.observedTabRenderer&&Ls(t,e),{element:e,height:t.cachedTabRendererHeight??e.getBoundingClientRect().height,scrollTop:e.scrollTop,maxScrollTop:Math.max(0,e.scrollHeight-e.clientHeight)}):null}function Ma(t){O(t),at(t),Ir(t)}function _a(t,e,r){let i=t.lines,s=[],n=!1;for(let o=0;o<i.length;o++){let l=i[o],a=i[o+1]?.time??1/0,c=e>=l.time-r&&(e<a||e<l.time+l.duration);Ra(l,c),c&&(s.push(l),t.selectedElementIndex=o,e>=l.time&&!t.lastScrollElements.includes(l)&&(n=!0))}return{lines:s,reachedUncommittedLine:n}}function Ra(t,e){t.isScrolled!==e&&(t.isScrolled=e,t.lyricElement.classList.toggle(pt,e))}function Oa(t,e,r){let i=Ge(t),s=i!==void 0&&(t.cachedCreditsItem?.height??0)>0&&r>=i.time+i.duration;return s===t.creditsFocused?!1:(t.creditsFocused=s,s?e.dataset.creditsFocused="true":delete e.dataset.creditsFocused,!0)}function Xe(t,e){if(t.layout==="stage")return!e||!t.lyricsContainer?!1:(t.cachedCreditsItem=It(t.lyricsContainer,P),us(t),pn(t));vs(t);let r=t.host.getScrollElement();if(r&&Xt(t,r),!e)return!1;let i=t.lyricsContainer;if(!i)return!1;t.lyricWidth=i.clientWidth,t.lyricHeight=i.clientHeight,ka(t,i);let s=pn(t);return t.cachedCreditsItem=It(i,P),t.cachedFooterItem=It(i,Ft),$t(t),hi(t),t.host.debug?.resize(),s}function pn(t){let e=!1;for(let r of t.lines)r.isAnimating&&r.parts.some(i=>i.sweepContext)&&(I(r),e=!0);return e}function ka(t,e){Lt(t);for(let r of t.lines){let i=X(e,r.lyricElement);r.position=i.y,r.height=i.height,r.decorations=new Map(Zi(r.lyricElement).map(s=>[s,X(e,s).y]))}}function hn(t){t.pendingLyricsUpdateFrame!==null&&(t.window.cancelAnimationFrame(t.pendingLyricsUpdateFrame),t.pendingLyricsUpdateFrame=null)}function gn(t,e){let r=e(M.lastEventCreationTime,M.lastPlayState);return Jt(t,M.lastTime,Ke(r))}function yn(t){t.lastTickOptions&&Jt(t,M.lastTime,t.lastTickOptions)}function bn(t,e,r){t.pendingLyricsUpdateFrame===null&&(O(t),t.pendingLyricsUpdateFrame=t.window.requestAnimationFrame(()=>{t.pendingLyricsUpdateFrame=null;let i=e(),s=i?Ji(t):null;Xe(t,i),s?.(),i&&r()}))}function Sn(t,e,r,i="scroll"){let s=e.matchMedia(Y),n=()=>Nt(o),o={document:t,window:e,host:r,lines:[],lyricsContainer:null,syncType:"none",lyricWidth:0,lyricHeight:0,skipScrolls:0,skipScrollsDecayTimes:[],scrollResumeTime:0,scrollPos:-1,selectedElementIndex:0,wasUserScrolling:!1,lastScrollElements:[],pinnedScrollLine:null,lastScrollDebugContext:{activeElms:[],centers:[],lyricScrollTime:0},passiveScrollAccumulatedTime:0,passiveLastWallTime:0,passiveScrollTop:null,cachedTabRendererHeight:null,cachedScrollInsets:Pe,cachedFooterItem:null,cachedCreditsItem:null,creditsFocused:!1,cachedLineScrollTiming:new Map,tabRendererResizeObserver:null,observedTabRenderer:null,runningLineScrolls:[],elementMotions:new Map,easingTables:new Map,lineScrollAnimationToken:0,pendingLineScroll:null,lineScrollElementTokens:new WeakMap,visibleWillChangeElements:new Set,culledLineElements:new Set,waveAnimationPool:[],lineCullObserver:null,cachedDurations:new Map,cachedCSSValues:new Map,cachedAnimationSettings:null,passiveScrollEnabled:!1,lastTickOptions:null,playbackRate:1,passiveRAFId:null,pendingLyricsUpdateFrame:null,learnedAnimationTimingOffsetMs:0,animationTimingVisibilityLogUntil:0,layout:i,stageKey:"",stageRemeasured:!1,stageHeight:0,stageBox:null,stageMetrics:new Map,stageY:new Map,stageMoves:new Map,stageFades:new Map,stageBlurs:new Map,stageFontSize:16,destroy:()=>{he.delete(o),s.removeEventListener("change",n),o.tabRendererResizeObserver?.disconnect(),o.tabRendererResizeObserver=null,o.observedTabRenderer=null,o.lineCullObserver?.disconnect(),o.lineCullObserver=null,ot(o),hn(o)}};return s.addEventListener("change",n),he.add(o),o}var wn=2,Ia=2e3;function Na(t,e,r,i){ks(t,e,r[i].durationMs),e.dataset.instrumental="true";let s=Ae(r,i);s&&(e.dataset.agent=s),ve(r,i)&&(e.classList.add(W),e.dataset.direction="rtl")}function Pa(t,e,r,i){let s=r.parts&&r.parts.length>0&&!Te.getBooleanValue()?r.parts:Di(r);wt(e,r.words),Pi(t,s,i,e),e.style.setProperty("--blyrics-duration",r.durationMs+"ms"),r.agent&&(e.dataset.agent=r.agent)}function Da(t){return t.length>1?`${t.slice(0,-1).join(", ")} & ${t.at(-1)}`:t[0]??""}function Fa(t,e){let r=t.createElement("p");r.className=P;let i=t.createElement("span");i.className=Gr;let s=t.createElement("span");return s.className=Vr,s.dir="auto",s.textContent=Da(e),i.appendChild(s),r.appendChild(i),r}var qe=new WeakMap,je=new WeakMap;function En(t){return JSON.stringify([t.words,t.translation??null,t.translations??null,t.romanization??null,t.timedRomanization??null])}var Ln=new WeakMap,Tn=new WeakMap;function An(t,e=t.parts){return[t.time,t.duration,...e.flatMap(r=>[r.time,r.duration])]}function Wa(t){let e=Tn.get(t);if(e===void 0)return!1;let r=An(t,t.parts.slice(0,(e.length-2)/2));return r.length===e.length&&r.every((i,s)=>i===e[s])}function vn(t,e,r){return{allZero:e.every(i=>i.startTimeMs===0),languages:Vt(e,r.language),seek:i=>t.host.seek(Wr(t,i))}}function Cn(t){return`${t.allZero}|${lr()}`}function xn(t,e){let r=t[e],i=r.parts?.map(n=>[n.startTimeMs,n.durationMs,n.words,n.isBackground===!0,n.backgroundGroup??null,n.explicit===!0]),s=r.isInstrumental?[Ae(t,e),ve(t,e)]:null;return JSON.stringify([r.startTimeMs,r.durationMs,r.words,r.isInstrumental===!0,r.agent??null,i??null,s,En(r)])}function Mn(t,e,r,i){let s=e[r],n=t.createElement("div"),o=Ni(n,s.startTimeMs,s.durationMs);return n.dataset.time=String(o.time),n.dataset.duration=String(o.duration),n.dataset.lineNumber=String(r),n.classList.add(Dt),n.dir="auto",St(n,i.languages[r]),Fi(i.seek,n,i.allZero),s.isInstrumental?Na(t,n,e,r):(Pa(t,n,s,o),s.words?.trim()||(n.dataset.blank="true")),qe.set(o,xn(e,r)),je.set(o,En(s)),Tn.set(o,An(o)),o}function _n(t,e,r,i,s=null){let n=t.document,o=Ii(r);if(e.dataset.sync=o,t.layout==="stage"){e.dataset.layout="stage";let a=r.filter(d=>!d.isInstrumental&&d.words?.trim()&&d.agent!=="v1000"),c=d=>d.agent==="v2"||d.agent==="v3";a.some(c)&&a.some(d=>!c(d))?e.dataset.stageDuet="":delete e.dataset.stageDuet}e.dataset.loaderVisible=String(i.loaderVisible),i.noLyrics?e.dataset.noLyrics="true":delete e.dataset.noLyrics,e.querySelector(`:scope > .${P}`)?.remove();let l=i.songwriters??[];l.length>0&&!i.noLyrics&&!Oi.getBooleanValue()&&e.insertBefore(Fa(n,l),s),t.syncType=o}function Rn(t,e,r,i){let s=t.document,n=s.createElement("div");n.className=Pt,rt()&&(n.dataset.browserEngine="gecko"),e.replaceChildren(n);let o=vn(t,r,i),l=[];for(let a of r.keys()){let c=Mn(s,r,a,o);l.push(c),n.appendChild(c.lyricElement)}t.skipScrolls=wn,t.skipScrollsDecayTimes=Array.from({length:wn},()=>Date.now()+Ia),t.scrollResumeTime=0,_n(t,n,r,i),t.lines=l,t.lyricsContainer=n,Ln.set(t,{mount:e,key:Cn(o),songKey:i.songKey}),Et(n,t.window),t.lyricWidth=n.clientWidth,t.lyricHeight=n.clientHeight,$t(t)}function Ha(t,e){let r=e.map(()=>null),i=0;for(;i<t.length&&i<e.length&&t[i]===e[i];)r[i]=i,i++;let s=t.length,n=e.length;for(;s>i&&n>i&&t[s-1]===e[n-1];)s--,n--,r[n]=s;let o=s-i,l=n-i;if(o===0||l===0||o*l>Ga)return r;let a=new Uint16Array((o+1)*(l+1)),c=(u,m)=>u*(l+1)+m;for(let u=o-1;u>=0;u--)for(let m=l-1;m>=0;m--)a[c(u,m)]=t[i+u]===e[i+m]?a[c(u+1,m+1)]+1:Math.max(a[c(u+1,m)],a[c(u,m+1)]);let d=0,f=0;for(;d<o&&f<l;)t[i+d]===e[i+f]?(r[i+f]=i+d,d++,f++):a[c(d+1,f)]>=a[c(d,f+1)]?d++:f++;return r}var Ga=25e4;function Va(t,e){let r=e.time+e.duration,i=t.findIndex(s=>{let n=s.time+s.duration;return s.time===e.time||s.time<r&&e.time<n});return i===-1?void 0:t.splice(i,1)[0]}function On(t,e,r,i){let s=t.lyricsContainer,n=Ln.get(t);if(s===null||n===void 0||n.mount!==e||s.parentElement!==e||i.songKey===void 0||i.songKey!==n.songKey)return null;let o=t.lines;if(r.length===0||o.length===0||o.some(L=>L.lyricElement.parentNode!==s))return null;let l=vn(t,r,i);if(n.key!==Cn(l))return null;let a=t.document,c=o.map(L=>Wa(L)?qe.get(L)??"":`\0moved:${qe.get(L)}`),d=r.map((L,C)=>xn(r,C)),f=Array.from(s.childNodes),u=s.querySelector(`:scope > .${P}`),m=u??o[o.length-1].lyricElement,p=f[f.indexOf(m)+1]??null,y=Ha(c,d),S=new Set,h=[],g=new Map,w=new Map,T=0,b=[],E=L=>{b=o.slice(T,L),T=L};for(let[L,C]of y.entries()){if(C!==null){let F=o[C];T=C+1,b=[],S.add(F),F.lyricElement.dataset.lineNumber=String(L),St(F.lyricElement,l.languages[L]),h.push(F),w.set(F,{position:F.position,height:F.height,motionOffset:0});continue}if(b.length===0){let F=y.slice(L).find(Wn=>Wn!==null);E(F??o.length)}let k=Mn(a,r,L,l),z=Va(b,k);z!==void 0&&(g.set(k,z),w.set(k,{position:z.position,height:z.height,motionOffset:ir(t,z.lyricElement)}),je.get(z)===je.get(k)&&Hi(z,k)),h.push(k)}let A=o.filter(L=>!S.has(L)),_=u??p;for(let L=h.length-1;L>=0;L--){let C=h[L].lyricElement;S.has(h[L])||s.insertBefore(C,_),_=C}bs(t,h,A,g);for(let L of A)L.lyricElement.remove();return _n(t,s,r,i,p),Et(s,t.window),w}var Ba="braccato:seek",Ua="Lyrics were handed to a renderer that has been destroyed; nothing was built",$a="The lines could not be re-measured after the document's faces loaded",Ya=new Set(["auto","scroll"]);function kn(){}function In(t){return t.length===0?!0:t.some(e=>e.lyricElement.getClientRects().length>0)}function za(t,e){for(let r=e;r!==null;r=r.parentElement)if(Ya.has(t.getComputedStyle(r).overflowY))return r;return e===null?null:e.ownerDocument.scrollingElement}function Ka(t,e,r){let i=t??{},s,n=null;function o(){let l=r();return l!==s&&(s=l,n=za(e,l)),n}return{host:{isViewVisible:i.isViewVisible??(()=>!0),isLoaderActive:i.isLoaderActive??(()=>!1),syncAdState:i.syncAdState??(()=>!1),getScrollElement:i.getScrollElement??o,setResumeAffordanceVisible:i.setResumeAffordanceVisible??kn,seek:i.seek??(l=>{r()?.dispatchEvent(new e.CustomEvent(Ba,{detail:l,bubbles:!0}))}),log:i.log??kn,onStageLayout:i.onStageLayout,debug:i.debug},forgetScrollElement(){s=void 0}}}function Nn(t){let e=t.document,r=t.window,i=t.mount??null,s=null,n=null,o=!1,l=[],a="",{host:c,forgetScrollElement:d}=Ka(t.host,r,()=>i),f=Sn(e,r,c,t.layout??"scroll"),u=[],m=()=>Et(f.lyricsContainer,r);function p(){if(lt.getBooleanValue()&&u.length===0){u=["(dynamic-range: high)","(forced-colors: active)"].map(b=>r.matchMedia(b));for(let b of u)b.addEventListener("change",m)}else if(!lt.getBooleanValue()){for(let b of u)b.removeEventListener("change",m);u=[]}m()}function y(b=!0){d(),Xe(f,b&&In(vt(f)))&&yn(f)}function S(){s?.disconnect(),s=null}function h(){S(),f.lyricsContainer?.remove(),ys(f),l=[],a=""}function g(b){S();let E=new r.ResizeObserver(A=>{let _=A[A.length-1]?.target;_&&mi(f,_.clientWidth,_.clientHeight)&&y()});E.observe(b),s=E}function w(b){let E=n??e.getElementById(pe);if(E!==null){E.textContent!==b&&(E.textContent=b);return}let A=e.createElement("style");A.id=pe,A.textContent=b,e.head.appendChild(A),n=A}let T=()=>y();return r.addEventListener("resize",T),e.fonts.ready.then(()=>{o||y()}).catch(b=>c.log($a,b)),{setLyrics(b,E){if(o){c.log(Ua);return}let A=E?.mount??i;if(!A)throw new Error("A lyrics renderer needs a mount: give one to createLyricsRenderer or to setLyrics");let _={language:E?.language,loaderVisible:E?.loaderVisible??!1,noLyrics:E?.noLyrics??!1,songwriters:E?.songwriters,songKey:E?.songKey},L=c.getScrollElement()?.scrollTop??0,C=On(f,A,b,_);C===null&&(h(),i=A,Rn(f,A,b,_)),p(),l=b,a=U(E?.language),y(),C!==null?Ss(f,C,L):f.lyricsContainer&&g(f.lyricsContainer)},setLanguage(b){let E=U(b);if(o||l.length===0||E===a)return;a=E;let A=Vt(l,E);vt(f).forEach((_,L)=>St(_.lyricElement,A[L])),y()},setTheme(b){if(o)return!1;let E=ie(or(b));return w(b),p(),Nt(f),y(),E},tick(b,E){return o?"lyrics-missing":Jt(f,b,Ke(E))},relayout(b=!0){o||y(b)},clear(){o||h()},destroy(){if(!o){o=!0,h(),n?.remove(),n=null,r.removeEventListener("resize",T);for(let b of u)b.removeEventListener("change",m);u=[],f.destroy()}},noteUserScroll(){o||fi(f,bt(f))},noteVisibilityChange(){o||en(f)},resumeAutoscroll(){o||di(f)},clearOnScreenLyrics(){return o?!1:hs(f)},scheduleLyricPositionUpdate(b,E){o||bn(f,()=>b()&&In(vt(f)),E)},retickFromPlaybackClock(b){return o?"lyrics-missing":gn(f,b)},get container(){return f.lyricsContainer},get lines(){return vt(f)},get syncType(){return f.lyricsContainer===null?"none":gs(f)}}}var Pn=`:root {
  /* Optional image paint; themes own the asset and any HDR brightness policy. */
  --blyrics-highlight-image: none;
  --blyrics-image-glow-opacity-from: 0.5;
  --blyrics-image-glow-opacity-to: 0;

	/* Colors */
	--blyrics-ui-text-color: var(
		--blyrics-text-color,
		color(display-p3 1 1 1 / 1)
	);
	--blyrics-glow-color: var(
		--blyrics-highlight-color,
		color(display-p3 1 1 1 / 0.5)
	);
	--blyrics-error-color: color(display-p3 0.992 0.882 0.882);
	--blyrics-footer-bg-color: hsla(0, 0%, 100%, 0.1);
	--blyrics-footer-border-color: hsla(0, 0%, 100%, 0.1);
	--blyrics-footer-text-color: #aaa;
	--blyrics-footer-link-color: #fff;
	--blyrics-discord-hover-color: #5865f2;
	--blyrics-vote-hover-color: hsla(0, 0%, 100%, 0.2);
	--blyrics-lyric-active-color: var(
		--blyrics-text-color,
		color(display-p3 1 1 1 / var(--blyrics-active-opacity, 1))
	);
	--blyrics-lyric-inactive-color: color(
		from var(--blyrics-text-color, color(display-p3 1 1 1)) display-p3 r g b /
			var(--blyrics-inactive-opacity, 0.3)
	);

	--blyrics-richsync-timing-offset: 0.150s;
	--blyrics-timing-offset: 0.115s;

	--blyrics-scroll-timing-offset: 0.5s;

	/* Typography */
	/* The stack behind --noto-sans-universal is 32 Noto families and the extension is what loads
	   them, so the declaration stays in misc.css, where two published themes select on it by name.
	   Inside the extension the fallback is unreachable. It is one real family rather than a generic
	   so that a standalone consumer without it still falls through to the rest of this stack; the
	   CJK, Devanagari, Arabic, Hebrew and Thai coverage is what such a consumer gives up either
	   way. */
	--blyrics-default-font-family:
		Satoshi, var(--noto-sans-universal, "Noto Sans"), Avenir, -apple-system,
		BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Open Sans,
		Helvetica Neue, sans-serif;
	--blyrics-font-size: 3rem;
	--blyrics-font-weight: 700;
	--blyrics-line-height: 1.333;

	--blyrics-translated-font-size: 2rem;
	--blyrics-translated-font-weight: 600;
	--blyrics-translated-color: color(
		display-p3 1 1 1 / var(--blyrics-translated-opacity, 0.6)
	);

	--blyrics-credits-label: "Written by";
	--blyrics-credits-font-size: max(0.4em, 12px);
	--blyrics-credits-opacity: 0.2;
	--blyrics-credits-focused-opacity: 0.85;

	--blyrics-footer-font-family: Satoshi, Roboto, Noto Naskh Arabic UI, Arial, sans-serif;
	--blyrics-footer-font-size: 14px;
	--blyrics-footer-font-weight: 400;

	/* Animations */
	--blyrics-animate-line-scale: 1;
	--blyrics-animate-word-wobble: 1;
	--blyrics-animate-highlight-swipe: 1;
	--blyrics-animate-highlight-glow: 1;
	--blyrics-animate-highlight-fade: 1;
	--blyrics-animate-scroll: 1;
	--blyrics-animate-instrumental: 1;
	--blyrics-animate-decoration-entry: 1;

	--blyrics-loader-transition-duration: 0.6s;
	--blyrics-loader-transition-easing: cubic-bezier(0.22, 1, 0.36, 1);
	--blyrics-scale-transition-duration: var(
		--blyrics-transition-duration,
		0.166s
	);
	--blyrics-line-enter-transform-from: scale(var(--blyrics-scale));
	--blyrics-line-enter-transform-to: scale(var(--blyrics-active-scale));
	--blyrics-line-exit-transform-from: scale(var(--blyrics-active-scale));
	--blyrics-line-exit-transform-to: scale(var(--blyrics-scale));
	--blyrics-line-enter-easing: ease;
	--blyrics-line-exit-easing: ease;

	--blyrics-lyric-highlight-fade-in-duration: var(
		--blyrics-opacity-transition,
		0.33s
	);
	--blyrics-lyric-highlight-fade-out-duration: var(
		--blyrics-opacity-transition,
		0.5s
	);
	--blyrics-lyric-highlight-fade-in-easing: ease;
	--blyrics-lyric-highlight-fade-out-easing: ease;
	--blyrics-highlight-swipe-easing: linear;
	--blyrics-highlight-swipe-start-from: -0.2;
	--blyrics-highlight-swipe-end-from: -0.1;
	--blyrics-highlight-swipe-start-to: 1.4;
	--blyrics-highlight-swipe-end-to: 1.5;
	--blyrics-highlight-glow-radius-from: 0.8rem;
	--blyrics-highlight-glow-radius-to: 0;
	--blyrics-highlight-glow-duration-ratio: 1.2;
	--blyrics-highlight-glow-min-duration: 1.2s;
	--blyrics-highlight-glow-easing: ease;

	--blyrics-wobble-duration: 1s;
	--blyrics-word-wobble-transform-from: scaleX(1);
	--blyrics-word-wobble-transform-peak: translateX(0.05em) scaleX(1.025);
	--blyrics-word-wobble-transform-settle: translateX(0) scaleX(1);
	--blyrics-word-wobble-transform-to: scaleX(1);
	--blyrics-word-wobble-peak-offset: 0.125;
	--blyrics-word-wobble-settle-offset: 0.75;
	--blyrics-word-wobble-easing: ease;
	--blyrics-word-wobble-peak-easing: ease-in-out;
	--blyrics-word-wobble-end-easing: ease-out;

	--blyrics-letter-wave-transform: translateY(-0.05em);
	--blyrics-letter-wave-settle: translateY(-0.02em);
	--blyrics-letter-wave-emphasis-scale: 1.11;
	--blyrics-letter-wave-duration: 0.9s;
	--blyrics-letter-wave-rise-easing: ease-in-out;
	--blyrics-letter-wave-fall-easing: ease-out;

	--blyrics-instrumental-fill-fade-duration: 150ms;
	--blyrics-instrumental-fill-fade-easing: ease;
	--blyrics-instrumental-fill-transform-from: translateY(78%);
	--blyrics-instrumental-fill-transform-to: translateY(-4%);
	--blyrics-instrumental-fill-easing: linear;
	--blyrics-instrumental-wave-transform-from: scaleY(1.2);
	--blyrics-instrumental-wave-transform-to: scaleY(0.0001);
	--blyrics-instrumental-wave-easing: ease-in;
	--blyrics-instrumental-wave-path-high: path("M -4 3 Q 1 2 5 3 Q 10 4 14 3 Q 18 2 22 3 Q 26 4 30 3 L 30 4 L -4 4 Z");
	--blyrics-instrumental-wave-path-low: path("M -4 3 Q 1 4 5 3 Q 10 2 14 3 Q 18 4 22 3 Q 26 2 30 3 L 30 4 L -4 4 Z");
	--blyrics-instrumental-wave-oscillation-duration: 1.25s;
	--blyrics-instrumental-wave-oscillation-easing: ease-in-out;

	/* Layout */
	--blyrics-padding: 2rem;
	--blyrics-margin: 2rem;
	--blyrics-small-border-radius: 1rem;
	--blyrics-border-radius: 1000rem;

	/* Effects */
	--blyrics-blur-amount: 30px;
	--blyrics-scale: 0.95;
	--blyrics-active-scale: 1;
	--blyrics-error-opacity: 0.33;
	--blyrics-background-blur: 100px;
	--blyrics-background-saturate: 2;

	/* Shared lyric scroll easing */
	--blyrics-lyric-scroll-timing-function: var(
		--blyrics-lyric-transition-timing-function,
		cubic-bezier(0.86, 0, 0.2, 1)
	);

	/* Gradient stops */
	--blyrics-gradient-stops:
		transparent 0%, rgba(0, 0, 0, 0.013) 8.1%, rgba(0, 0, 0, 0.049) 15.5%,
		rgba(0, 0, 0, 0.104) 22.5%, rgba(0, 0, 0, 0.175) 29%,
		rgba(0, 0, 0, 0.259) 35.3%, rgba(0, 0, 0, 0.352) 41.2%,
		rgba(0, 0, 0, 0.45) 47.1%, rgba(0, 0, 0, 0.55) 52.9%,
		rgba(0, 0, 0, 0.648) 58.8%, rgba(0, 0, 0, 0.741) 64.7%,
		rgba(0, 0, 0, 0.825) 71%, rgba(0, 0, 0, 0.896) 77.5%,
		rgba(0, 0, 0, 0.951) 84.5%, rgba(0, 0, 0, 0.987) 91.9%, #000 100%;

	--blyrics-shimmer-gradient: linear-gradient(
		110deg,
		color-mix(in srgb, var(--blyrics-ui-text-color) 50%, transparent) 30%,
		var(--blyrics-ui-text-color) 50%,
		color-mix(in srgb, var(--blyrics-ui-text-color) 50%, transparent) 70%
	);
}

/* Reduced-motion disables the vestibular triggers (zoom-on-active line scale,
   translateX word wobble, and instrumental fill/wave motion) and flattens the
   active/inactive scale delta. Smooth scroll remains enabled, but the animation
   engine suppresses side-specific line-scroll differential effects.
   Everything else is left on by design:
     - karaoke swipe + highlight glow: gradient mask / drop-shadow fills, not movement.
     - highlight fade-in / fade-out: opacity transitions are not motion. */
@media (prefers-reduced-motion: reduce) {
	:root {
		--blyrics-animate-line-scale: 0;
		--blyrics-animate-word-wobble: 0;
		--blyrics-animate-instrumental: 0;
		--blyrics-animate-decoration-entry: 0;

		--blyrics-scale: 1;
		--blyrics-active-scale: 1;
	}
}
`;var Dn=`@import url("image-highlights.css");

/* Resolve the default stack at each language boundary. A root-level var() would freeze
   the host's language-specific fallback before the lyric/translation language is known.
   Theme overrides remain inherited through --blyrics-font-family. */
.blyrics--line,
.blyrics--translated,
.blyrics--romanized {
	--blyrics-default-font-family:
		Satoshi, var(--noto-sans-universal, "Noto Sans"), Avenir, -apple-system,
		BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Open Sans,
		Helvetica Neue, sans-serif;
	font-family: var(--blyrics-font-family, var(--blyrics-default-font-family));
}

/* Main container styles */
.blyrics-container {
	font-family: var(--blyrics-font-family, var(--blyrics-default-font-family));
	font-size: var(--blyrics-font-size);
	font-weight: var(--blyrics-font-weight);
	isolation: isolate;
	line-height: var(--blyrics-line-height);
	padding-bottom: calc(var(--blyrics-padding-bottom));
	padding-top: 2rem;
	position: relative !important;
	will-change: transform;
	z-index: 1;
}

.blyrics-container > div {
	box-sizing: border-box;
	cursor: pointer;
	padding: var(--blyrics-padding) 0.25em !important;
	transform: scale(var(--blyrics-scale));
	transform-origin: left center;
}

.blyrics--active {
	cursor: default;
}

.blyrics--line {
	color: var(--blyrics-lyric-inactive-color);
	max-width: 100%;
	unicode-bidi: plaintext;
	white-space: normal;
	word-break: normal;
}

.blyrics-line-main {
	display: block;
	max-width: 100%;
	overflow-wrap: normal;
	position: relative;
	text-align: inherit;
	unicode-bidi: plaintext;
	white-space: normal;
}

.blyrics-background-line {
	display: block;
	margin-top: 0.1em;
	max-width: 100%;
	position: relative;
	text-align: inherit;
	unicode-bidi: plaintext;
	white-space: normal;
}

.blyrics-bidi-run {
	display: block;
	max-width: 100%;
	unicode-bidi: normal;
	white-space: inherit;
}

.blyrics-highlight-run {
	inset: 0 0 auto;
	pointer-events: none;
	position: absolute;
	user-select: none;
	width: auto;
	z-index: 1;
}

.blyrics-word-group {
	display: inline-block;
	max-width: 100%;
	unicode-bidi: normal;
	vertical-align: baseline;
	white-space: nowrap;
}

.blyrics-word-group-long {
	display: inline;
	overflow-wrap: anywhere;
	white-space: normal;
	word-break: break-word;
}

.blyrics--word {
	color: var(--blyrics-lyric-inactive-color);
	display: inline;
	position: relative;
	transform: translateY(0);
	unicode-bidi: normal;
	white-space: inherit;
}

.blyrics-word-group:not(.blyrics-word-group-long) .blyrics--word {
	display: inline-block;
}

.blyrics-bidi-sensitive .blyrics-word-group,
.blyrics-bidi-sensitive .blyrics-word-group-long {
	display: contents;
	max-width: none;
	overflow-wrap: normal;
	unicode-bidi: normal;
	white-space: normal;
	word-break: normal;
}

.blyrics-bidi-sensitive .blyrics--word,
.blyrics-bidi-sensitive .blyrics-word-group:not(.blyrics-word-group-long) .blyrics--word {
	display: inline;
	white-space: inherit;
}

.blyrics--word.blyrics-word-highlight {
	opacity: 0;
	pointer-events: none;
}

.blyrics--letter {
	display: inline-block;
}

/* Atomic letter boxes otherwise take their visual ordering from the surrounding
   paragraph. Isolate each word's own dir=auto while keeping it inline/wrappable. */
.blyrics--word.blyrics-word--lettered {
	unicode-bidi: isolate;
}

/* WebRender snaps 2D-translated glyphs to whole pixels; perspective rasterizes them in local space. */
.blyrics-container[data-browser-engine="gecko"] .blyrics--animating .blyrics-word--lettered {
	perspective: 100000px;
}

/* The compositor's sweep. A cell is a word that is its own inline-block box, or one letter of a word
   that flows inline. Its mask box is 3 + fade cells wide and starts a cell before the cell: opaque up
   to half a cell past the cell's end (SWEEP_REST in sweepPlans.ts), then a soft edge \`fade\` cells
   wide, where fade is the swipe's width from its last start stop to its last end stop, in cells. The
   engine slides the mask back to where the swipe begins and the text inside it the other way by the
   same distance, so the glyphs hold still while the edge crosses them. The glow's two halos sit in
   that same text, so the edge reveals them with it. With nothing animating the mask rests with the
   cell lit and its halos whole. */
.blyrics--word.blyrics-word-highlight.blyrics-word-highlight--sweep {
	color: var(--blyrics-lyric-active-color);
	--blyrics-sweep-angle: 90deg;
	--blyrics-sweep-fade: calc(
		var(--blyrics-highlight-swipe-end-to, 1.5) - var(--blyrics-highlight-swipe-start-to, 1.4)
	);
}

.blyrics--word.blyrics-word-highlight.blyrics-word-highlight--sweep.blyrics-rtl,
.blyrics-sweep-window.blyrics-sweep-cell[dir="rtl"] {
	--blyrics-sweep-angle: 270deg;
}

.blyrics-word-highlight--sweep .blyrics--letter.blyrics-sweep-cell {
	--blyrics-sweep-fade: calc(
		(var(--blyrics-highlight-swipe-end-to, 1.5) - var(--blyrics-highlight-swipe-start-to, 1.4)) *
			var(--letters, 1)
	);
}

/* The mask boxes are laid out by direction, which a \`dir="auto"\` word does not hand down to its letters,
   so each cell takes the direction of the word the engine sweeps it for. */
.blyrics-sweep-cell {
	direction: ltr;
	/* The mask boxes add nothing to the row's scroll width; the margin keeps the glow's halo. */
	overflow: clip;
	overflow-clip-margin: 2rem;
	position: relative;
}

.blyrics-word-highlight--sweep.blyrics-rtl .blyrics-sweep-cell,
.blyrics-sweep-window.blyrics-sweep-cell[dir="rtl"] {
	direction: rtl;
}

.blyrics-sweep-mask {
	--blyrics-sweep-widths: calc(3 + var(--blyrics-sweep-fade));
	box-sizing: content-box;
	display: block;
	margin-inline-start: -100%;
	width: calc(var(--blyrics-sweep-widths) * 100%);
	/* Room above and below for the halo, the letter wave and glyphs that reach past the line box. */
	padding-block: calc(0.5em + var(--blyrics-highlight-glow-radius-from, 0.8rem));
	margin-block: calc(-0.5em - var(--blyrics-highlight-glow-radius-from, 0.8rem));
	--blyrics-sweep-solid: calc(250% / var(--blyrics-sweep-widths));
	--blyrics-sweep-clear: calc((2.5 + var(--blyrics-sweep-fade)) * 100% / var(--blyrics-sweep-widths));
	-webkit-mask-image: linear-gradient(var(--blyrics-sweep-angle), #000 var(--blyrics-sweep-solid), #0000 var(--blyrics-sweep-clear));
	mask-image: linear-gradient(var(--blyrics-sweep-angle), #000 var(--blyrics-sweep-solid), #0000 var(--blyrics-sweep-clear));
	-webkit-mask-repeat: no-repeat;
	mask-repeat: no-repeat;
}

.blyrics-sweep-text {
	box-sizing: content-box;
	display: block;
	isolation: isolate;
	margin-inline-start: calc(100% / var(--blyrics-sweep-widths));
	position: relative;
	width: calc(100% / var(--blyrics-sweep-widths));
}

/* A halo is a copy of the text whose own glyphs are clear, under a text shadow that never changes; the
   engine fades it by opacity. */
.blyrics-sweep-glow {
	--blyrics-sweep-glow-radius: var(--blyrics-highlight-glow-radius-from, 0.8rem);
	color: transparent;
	inset: 0;
	opacity: 0;
	pointer-events: none;
	position: absolute;
	text-shadow: 0 0 var(--blyrics-sweep-glow-radius) var(--blyrics-glow-color);
	user-select: none;
	z-index: -1;
}

/* The glow shrinks as it fades. The engine crossfades from the wide halo to this one, which sits where
   the radius has shrunk to by the time the wide one is gone. */
.blyrics-sweep-glow--tight {
	--blyrics-sweep-glow-radius: calc(var(--blyrics-highlight-glow-radius-from, 0.8rem) * 0.4);
}

/* A word that flows inline keeps its text here only for layout; its sweep is drawn by cells placed over
   each box it breaks into, which show the word from copies of its line. */
.blyrics--word.blyrics-word-highlight.blyrics-word-highlight--context {
	color: transparent;
}

.blyrics-sweep-context {
	inset: 0;
	opacity: 0;
	pointer-events: none;
	position: absolute;
	user-select: none;
	z-index: 1;
}

.blyrics-sweep-window {
	--blyrics-sweep-angle: 90deg;
	position: absolute;
}

.blyrics-sweep-window .blyrics-sweep-mask,
.blyrics-sweep-window .blyrics-sweep-text {
	height: 100%;
}

.blyrics-sweep-clone {
	color: transparent;
	max-width: none;
	position: absolute;
	text-shadow: none;
}

.blyrics-sweep-clone .blyrics--word {
	color: transparent;
}

.blyrics-sweep-clone .blyrics--word.blyrics-sweep-target {
	color: var(--blyrics-lyric-active-color);
}

.blyrics-sweep-glow .blyrics-sweep-clone .blyrics--word.blyrics-sweep-target {
	color: transparent;
	text-shadow: 0 0 var(--blyrics-sweep-glow-radius) var(--blyrics-glow-color);
}

/* text-decoration skips inline-block letters and rides the wave, so draw on the word box instead, from its
   center (fixed against the text at any line-height), with layout-neutral padding so a tight box can hold it. */
[blyrics-alt-hover] .blyrics--word:hover {
	padding-block: 0.25em;
	margin-block: -0.25em;
	background-image: linear-gradient(currentColor, currentColor);
	background-position: 0 calc(50% + 0.54em);
	background-repeat: no-repeat;
	background-size: 100% 0.06em;
}

.blyrics--line > .blyrics-line-main > .blyrics-background-lyric,
.blyrics--line > .blyrics-background-line > .blyrics-background-lyric,
.blyrics--line > .blyrics-line-main > .blyrics-bidi-run > .blyrics-background-lyric,
.blyrics--line > .blyrics-background-line > .blyrics-bidi-run > .blyrics-background-lyric,
.blyrics-sweep-clone > .blyrics-background-lyric {
	font-size: 0.75em;
	font-weight: 500;
}

.blyrics--line > .blyrics-line-main > .blyrics-word-group.blyrics-background-lyric,
.blyrics--line > .blyrics-background-line > .blyrics-word-group.blyrics-background-lyric,
.blyrics--line > .blyrics-line-main > .blyrics-bidi-run > .blyrics-word-group.blyrics-background-lyric,
.blyrics--line > .blyrics-background-line > .blyrics-bidi-run > .blyrics-word-group.blyrics-background-lyric {
	color: color-mix(in srgb, var(--blyrics-lyric-inactive-color) 78%, transparent);
}

.blyrics--translated,
.blyrics--romanized {
	animation: blyrics-decoration-in calc(var(--blyrics-animate-decoration-entry) * 0.35s)
		cubic-bezier(0.25, 1, 0.5, 1) both;
	color: var(--blyrics-translated-color);
	display: block;
	font-family: var(--blyrics-translated-font-family, var(--blyrics-font-family, var(--blyrics-default-font-family)));
	font-size: var(--blyrics-translated-font-size);
	font-weight: var(--blyrics-translated-font-weight);
	line-height: normal;
	margin-top: 8px;
	max-width: 100%;
	text-align: inherit;
	unicode-bidi: plaintext;
	white-space: normal;
}

@keyframes blyrics-decoration-in {
	from {
		opacity: 0;
		transform: translateY(-0.4em);
	}
}

.blyrics-container > .blyrics-credits {
	box-sizing: border-box;
	cursor: default;
	margin: 0;
	padding: var(--blyrics-padding) 0.25em;
	transform: scale(var(--blyrics-scale));
	transform-origin: left center;
}

.blyrics-credits {
	color: var(--blyrics-ui-text-color);
	opacity: var(--blyrics-credits-opacity);
	transition: opacity 0.35s cubic-bezier(0.25, 1, 0.5, 1);
}

.blyrics-credits__text {
	display: block;
	font-size: var(--blyrics-credits-font-size);
}

.blyrics-credits__text::before {
	content: var(--blyrics-credits-label) " ";
}

.blyrics-container[data-credits-focused] > .blyrics-credits,
.blyrics-container[data-sync="none"] > .blyrics-credits {
	opacity: var(--blyrics-credits-focused-opacity);
}

.blyrics--romanized {
	background: rgba(255, 255, 255, 0.05);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 1rem;
	box-sizing: border-box;
	display: block;
	font-size: calc(var(--blyrics-translated-font-size) / 1.25);
	padding: 0.25rem 0.75rem;
	width: fit-content;
}

.blyrics-rtl {
	direction: rtl;
}

.blyrics--line[data-direction="rtl"] {
	text-align: right;
	transform-origin: right center;
}

/* Secondary and tertiary vocals */
.blyrics--line[data-agent="v2"],
.blyrics--line[data-agent="v3"] {
	text-align: right;
	transform-origin: right center !important;
}

/* All vocals together */
.blyrics--line[data-agent="v1000"] {
	text-align: center;
	transform-origin: center center !important;
}

.blyrics--line[data-agent="v2"] .blyrics--romanized,
.blyrics--line[data-agent="v3"] .blyrics--romanized,
.blyrics--line[data-direction="rtl"] .blyrics--romanized {
	margin-left: auto;
}

.blyrics--line[data-agent="v1000"] .blyrics--romanized {
	margin-left: auto;
	margin-right: auto;
}

#blyrics-wrapper {
	margin-top: 0;
}
`;var Fn=`/* Instrumental break styles */
.blyrics--instrumental-icon {
	height: var(--blyrics-font-size);
	width: calc(var(--blyrics-font-size) + var(--blyrics-font-size) / 3);
	overflow: visible;
	margin-left: calc(var(--blyrics-font-size) / -3);
}

.blyrics-rtl.blyrics--instrumental .blyrics--instrumental-icon {
	margin-left: 0;
	margin-right: calc(var(--blyrics-font-size) / -3);
}

.blyrics--instrumental[data-agent="v2"] .blyrics--instrumental-icon,
.blyrics--instrumental[data-agent="v3"] .blyrics--instrumental-icon {
	margin-left: 0px;
	margin-right: calc(var(--blyrics-font-size) / -3);
}

.blyrics--instrumental[data-agent="v1000"] .blyrics--instrumental-icon {
	margin-left: 0;
	margin-right: 0;
}

.blyrics--instrumental-bg {
	fill: var(--blyrics-lyric-inactive-color);
}

.blyrics--instrumental-fill {
	fill: var(--blyrics-lyric-active-color);
	transition: opacity var(--blyrics-lyric-highlight-fade-out-duration, 0.5s) ease;
	opacity: 0;
}

.blyrics--instrumental.blyrics--animating .blyrics--instrumental-fill {
	transition: none;
	opacity: 1;
}

.blyrics--instrumental:not(.blyrics--pre-animating) .blyrics--wave-clip {
	transition-property: transform;
	transition-duration: 1000000s;
	transition-delay: 0s;
	transform: translateY(0%);
}

.blyrics--instrumental.blyrics--pre-animating:not(.blyrics--animating) .blyrics--wave-clip {
	animation: none;
	transform: translateY(78%);
}

.blyrics--instrumental.blyrics--animating .blyrics--wave-clip {
	transition-property: transform;
	transition-duration: calc(var(--blyrics-duration, 1ms) * 1);
	transition-timing-function: linear;
	transition-delay: var(--blyrics-anim-delay);
	transform: translateY(-4%);
}

.blyrics--wave-path {
	/* Set the transform origin to the bottom of the wave shape (y=4). */
	transform-box: fill-box;
	transform-origin: bottom;

	/* Prepare the WAAPI flatten transition. */
	transform: scaleY(1.2);

	d: var(--blyrics-instrumental-wave-path-high);
}

/* Gecko misplaces a fill-box origin inside a clipPath, so pin the wave's floor (y=4) in user units. */
.blyrics-container[data-browser-engine="gecko"] .blyrics--wave-path {
	transform-box: view-box;
	transform-origin: 0 4px;
}

/* Trigger the Flattening */
.blyrics--instrumental.blyrics--animating:not(.blyrics--paused) .blyrics--wave-path {
	/* Flatten the wave to 0 height */
	transform: scaleY(0);

	transition-property: transform;
	transition-duration: calc(var(--blyrics-duration, 1ms) * 1);
	transition-timing-function: ease-in;
	transition-delay: var(--blyrics-anim-delay);
}

/* If paused, we freeze the flattening where it is */
.blyrics--instrumental.blyrics--animating.blyrics--paused .blyrics--wave-path {
	transform: scaleY(0.0001); /* slightly different to force recalculation */
	transition-duration: 10000000000s;
	transition-property: transform;
	transition-timing-function: ease-out;
	transition-delay: 0s;
}
`;var $f=[Pn,Dn,Fn].join(`
`);export{$f as CSS,Nn as createLyricsRenderer,Gi as injectTranslation,Wi as removeTranslation,ie as setThemeSettings};
