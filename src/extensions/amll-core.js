// rolldown-runtime-D7D4PA-g.mjs
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
  let target = {};
  for (var name in all) __defProp(target, name, {
    get: all[name],
    enumerable: true
  });
  if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
  return target;
};

// stub.js
function makeStub() {
  const target = function() {
  };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return void 0;
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "length") return 0;
      if (prop === "nodeType") return 1;
      if (prop === "style") return makeStub();
      if (prop === "prototype") return makeStub();
      return makeStub();
    },
    set() {
      return true;
    },
    apply() {
      return makeStub();
    },
    construct() {
      return makeStub();
    }
  });
}
var Mat4 = makeStub();
var Vec2 = makeStub();
var Vec3 = makeStub();
var Vec4 = makeStub();
var Application = makeStub();
var Texture = makeStub();
var utils = makeStub();
var Container = makeStub();
var BlurFilter = makeStub();
var BulgePinchFilter = makeStub();
var ColorMatrixFilter = makeStub();
var Sprite = makeStub();
var stub_default = makeStub();

// node_modules/@ungap/structured-clone/esm/types.js
var VOID = -1;
var PRIMITIVE = 0;
var ARRAY = 1;
var OBJECT = 2;
var DATE = 3;
var REGEXP = 4;
var MAP = 5;
var SET = 6;
var ERROR = 7;
var BIGINT = 8;

// node_modules/@ungap/structured-clone/esm/deserialize.js
var { defineProperty } = Object;
var env = typeof self === "object" ? self : globalThis;
var guard = (name, init) => {
  switch (name) {
    case "Function":
    case "SharedWorker":
    case "Worker":
    case "eval":
    case "setInterval":
    case "setTimeout":
      throw new TypeError("unable to deserialize " + name);
  }
  return new env[name](init);
};
var deserializer = ($, _) => {
  const as = (out, index) => {
    $.set(index, out);
    return out;
  };
  const unpair = (index) => {
    if ($.has(index))
      return $.get(index);
    const [type, value] = _[index];
    switch (type) {
      case PRIMITIVE:
      case VOID:
        return as(value, index);
      case ARRAY: {
        const arr = as([], index);
        for (const index2 of value)
          arr.push(unpair(index2));
        return arr;
      }
      case OBJECT: {
        const object = as({}, index);
        for (const [key, index2] of value) {
          const k = unpair(key), value2 = unpair(index2);
          if (k === "__proto__") defineProperty(object, k, {
            value: value2,
            configurable: true,
            enumerable: true,
            writable: true
          });
          else object[k] = value2;
        }
        return object;
      }
      case DATE:
        return as(new Date(value), index);
      case REGEXP: {
        const { source, flags } = value;
        return as(new RegExp(source, flags), index);
      }
      case MAP: {
        const map = as(/* @__PURE__ */ new Map(), index);
        for (const [key, index2] of value)
          map.set(unpair(key), unpair(index2));
        return map;
      }
      case SET: {
        const set = as(/* @__PURE__ */ new Set(), index);
        for (const index2 of value)
          set.add(unpair(index2));
        return set;
      }
      case ERROR: {
        const { name, message } = value;
        return as(
          typeof env[name] === "function" ? guard(name, message) : new Error(message),
          index
        );
      }
      case BIGINT:
        return as(BigInt(value), index);
      case "BigInt":
        return as(Object(BigInt(value)), index);
      case "ArrayBuffer":
        return as(new Uint8Array(value).buffer, value);
      case "DataView": {
        const { buffer } = new Uint8Array(value);
        return as(new DataView(buffer), value);
      }
      case "-0":
        return -0;
    }
    return as(guard(type, value), index);
  };
  return unpair;
};
var deserialize = (serialized) => deserializer(/* @__PURE__ */ new Map(), serialized)(0);

// node_modules/@ungap/structured-clone/esm/serialize.js
var EMPTY = "";
var { toString } = {};
var { keys, is } = Object;
var typeOf = (value) => {
  const type = typeof value;
  if (type !== "object" || !value)
    return [PRIMITIVE, type];
  const asString = toString.call(value).slice(8, -1);
  switch (asString) {
    case "Array":
      return [ARRAY, EMPTY];
    case "Object":
      return [OBJECT, EMPTY];
    case "Date":
      return [DATE, EMPTY];
    case "RegExp":
      return [REGEXP, EMPTY];
    case "Map":
      return [MAP, EMPTY];
    case "Set":
      return [SET, EMPTY];
    case "DataView":
      return [ARRAY, asString];
  }
  if (asString.includes("Array"))
    return [ARRAY, asString];
  if (value instanceof Error)
    return [ERROR, value.name || "Error"];
  return [OBJECT, asString];
};
var shouldSkip = ([TYPE, type]) => TYPE === PRIMITIVE && (type === "function" || type === "symbol");
var serializer = (strict, json, $, _) => {
  const as = (out, value) => {
    const index = _.push(out) - 1;
    $.set(value, index);
    return index;
  };
  const pair = (value) => {
    if ($.has(value))
      return $.get(value);
    let [TYPE, type] = typeOf(value);
    switch (TYPE) {
      case PRIMITIVE: {
        let entry = value;
        switch (type) {
          case "bigint":
            TYPE = BIGINT;
            entry = value.toString();
            break;
          case "number":
            if (!value && is(value, -0))
              return _.push(["-0"]) - 1;
            break;
          case "function":
          case "symbol":
            if (strict)
              throw new TypeError("unable to serialize " + type);
            entry = null;
            break;
          case "undefined":
            return as([VOID], value);
        }
        return as([TYPE, entry], value);
      }
      case ARRAY: {
        if (type) {
          let spread = value;
          if (type === "DataView") {
            spread = new Uint8Array(value.buffer);
          } else if (type === "ArrayBuffer") {
            spread = new Uint8Array(value);
          }
          return as([type, [...spread]], value);
        }
        const arr = [];
        const index = as([TYPE, arr], value);
        for (const entry of value)
          arr.push(pair(entry));
        return index;
      }
      case OBJECT: {
        if (type) {
          switch (type) {
            case "BigInt":
              return as([type, value.toString()], value);
            case "Boolean":
            case "Number":
            case "String":
              return as([type, value.valueOf()], value);
          }
        }
        if (json && "toJSON" in value)
          return pair(value.toJSON());
        const entries = [];
        const index = as([TYPE, entries], value);
        for (const key of keys(value)) {
          if (strict || !shouldSkip(typeOf(value[key])))
            entries.push([pair(key), pair(value[key])]);
        }
        return index;
      }
      case DATE:
        return as([TYPE, isNaN(value.getTime()) ? EMPTY : value.toISOString()], value);
      case REGEXP: {
        const { source, flags } = value;
        return as([TYPE, { source, flags }], value);
      }
      case MAP: {
        const entries = [];
        const index = as([TYPE, entries], value);
        for (const [key, entry] of value) {
          if (strict || !(shouldSkip(typeOf(key)) || shouldSkip(typeOf(entry))))
            entries.push([pair(key), pair(entry)]);
        }
        return index;
      }
      case SET: {
        const entries = [];
        const index = as([TYPE, entries], value);
        for (const entry of value) {
          if (strict || !shouldSkip(typeOf(entry)))
            entries.push(pair(entry));
        }
        return index;
      }
    }
    const { message } = value;
    return as([TYPE, { name: type, message }], value);
  };
  return pair;
};
var serialize = (value, { json, lossy } = {}) => {
  const _ = [];
  return serializer(!(json || lossy), !!json, /* @__PURE__ */ new Map(), _)(value), _;
};

// node_modules/@ungap/structured-clone/esm/index.js
var esm_default = typeof structuredClone === "function" ? (
  /* c8 ignore start */
  (any, options) => options && ("json" in options || "lossy" in options) ? deserialize(serialize(any, options)) : structuredClone(any)
) : (any, options) => deserialize(serialize(any, options));

// node_modules/bezier-easing/src/index.js
function LinearEasing(x) {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}
var { min, max, cbrt, sqrt, acos, cos } = Math;
var x2t = (x, a, b, c) => {
  const j = 1 / max(c, sqrt(x));
  const k = x * j;
  const l = k * j;
  const s = c * j;
  const q = b * l;
  const m = s * s + q;
  const h = -s * (s * s + 1.5 * q) - a * k * l;
  const D = h * h - m * m * m;
  let v;
  if (!m || D > 1e-12 * h * h) {
    const U = -cbrt(h < 0 ? h - sqrt(D) : h + sqrt(D));
    v = U + m / U || 0;
  } else {
    const r = sqrt(m);
    v = 2 * r * cos(acos(max(-1, min(1, -h / (m * r)))) / 3);
  }
  return min(1, k / (v + s));
};
var Y = (t, ay, by, cy) => ((ay * t + by) * t + cy) * t;
function bezier(mX1, mY1, mX2, mY2) {
  if (!(0 <= mX1 && mX1 <= 1 && 0 <= mX2 && mX2 <= 1)) {
    throw new Error("bezier x values must be in [0, 1] range");
  }
  if (mX1 === mY1 && mX2 === mY2) {
    return LinearEasing;
  }
  const a = (3 * mX1 - 3 * mX2 + 1) / 2;
  const b = mX2 - 2 * mX1;
  const c = mX1;
  const ay = 3 * mY1 - 3 * mY2 + 1;
  const by = 3 * (mY2 - 2 * mY1);
  const cy = 3 * mY1;
  return function BezierEasing(x) {
    if (!(x > 0 && x < 1)) {
      return LinearEasing(x);
    }
    return Y(x2t(x, a, b, c), ay, by, cy);
  };
}

// amll-core.mjs
var AbstractBaseRenderer = class {
};
function clamp1(x) {
  return Math.max(1, x);
}
var BaseRenderer = class extends AbstractBaseRenderer {
  canvas;
  observer;
  flowSpeed = 1;
  currerntRenderScale = 0.75;
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.observer = new ResizeObserver(() => {
      const width = clamp1(canvas.clientWidth * window.devicePixelRatio * this.currerntRenderScale);
      const height = clamp1(canvas.clientHeight * window.devicePixelRatio * this.currerntRenderScale);
      this.onResize(width, height);
    });
    this.observer.observe(canvas);
  }
  setRenderScale(scale) {
    this.currerntRenderScale = scale;
    this.onResize(this.canvas.clientWidth * window.devicePixelRatio * this.currerntRenderScale, this.canvas.clientHeight * window.devicePixelRatio * this.currerntRenderScale);
  }
  /**
  * 当画板元素大小发生变化时此函数会被调用
  * 可以在此处重设和渲染器相关的尺寸设置
  * 考虑到初始化的时候元素不一定在文档中或出于某些特殊样式状态，尺寸长宽有可能会为 0，请注意进行特判处理
  * @param width 画板元素实际的物理像素宽度，有可能为 0
  * @param height 画板元素实际的物理像素高度，有可能为 0
  */
  onResize(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
  }
  /**
  * 修改背景的流动速度，数字越大越快，默认为 1
  * @param speed 背景的流动速度，默认为 1
  */
  setFlowSpeed(speed) {
    this.flowSpeed = speed;
  }
  /** 停止监听画板尺寸，供构造失败等尚未接管画板所有权的路径清理 */
  disconnectResizeObserver() {
    this.observer.disconnect();
  }
  dispose() {
    this.disconnectResizeObserver();
    this.canvas.remove();
  }
  getElement() {
    return this.canvas;
  }
};
var GLProgram = class {
  label;
  gl;
  program;
  vertexShader;
  fragmentShader;
  attrs;
  uniformLocations = /* @__PURE__ */ new Map();
  constructor(gl, vertexShaderSource, fragmentShaderSource, label = "unknown") {
    this.label = label;
    this.gl = gl;
    const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexShaderSource);
    let fragmentShader;
    try {
      fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
      this.program = this.createProgram(vertexShader, fragmentShader);
    } catch (error) {
      gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      throw error;
    }
    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;
    const num = gl.getProgramParameter(this.program, gl.ACTIVE_ATTRIBUTES);
    const attrs = {};
    for (let i = 0; i < num; i++) {
      const info = gl.getActiveAttrib(this.program, i);
      if (!info) continue;
      const location = gl.getAttribLocation(this.program, info.name);
      if (location === -1) continue;
      attrs[info.name] = location;
    }
    this.attrs = attrs;
  }
  createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Failed to create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = /* @__PURE__ */ new Error(`Failed to compile shader for type ${type} "${this.label}": ${gl.getShaderInfoLog(shader)}`);
      gl.deleteShader(shader);
      throw error;
    }
    return shader;
  }
  createProgram(vertexShader, fragmentShader) {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error("Failed to create program");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const errLog = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Failed to link program "${this.label}": ${errLog}`);
    }
    return program;
  }
  use() {
    this.gl.useProgram(this.program);
  }
  notFoundUniforms = /* @__PURE__ */ new Set();
  warnUniformNotFound(name) {
    if (this.notFoundUniforms.has(name)) return;
    this.notFoundUniforms.add(name);
    console.warn(`Failed to get uniform location for program "${this.label}": ${name}`);
  }
  /**
  * 取 uniform 位置并缓存。逐帧设置几十个 uniform 时，省下的
  * `getUniformLocation` 调用相当可观。
  */
  getUniformLocation(name) {
    let location = this.uniformLocations.get(name);
    if (location === void 0) {
      location = this.gl.getUniformLocation(this.program, name);
      this.uniformLocations.set(name, location);
    }
    if (location === null) this.warnUniformNotFound(name);
    return location;
  }
  setUniform1f(name, value) {
    const location = this.getUniformLocation(name);
    if (location !== null) this.gl.uniform1f(location, value);
  }
  setUniform2f(name, value1, value2) {
    const location = this.getUniformLocation(name);
    if (location !== null) this.gl.uniform2f(location, value1, value2);
  }
  setUniform3f(name, value1, value2, value3) {
    const location = this.getUniformLocation(name);
    if (location !== null) this.gl.uniform3f(location, value1, value2, value3);
  }
  setUniform4f(name, value1, value2, value3, value4) {
    const location = this.getUniformLocation(name);
    if (location !== null) this.gl.uniform4f(location, value1, value2, value3, value4);
  }
  setUniform1i(name, value) {
    const location = this.getUniformLocation(name);
    if (location !== null) this.gl.uniform1i(location, value);
  }
  setUniform1fv(name, value) {
    const location = this.getUniformLocation(name);
    if (location !== null) this.gl.uniform1fv(location, value);
  }
  setUniform3fv(name, value) {
    const location = this.getUniformLocation(name);
    if (location !== null) this.gl.uniform3fv(location, value);
  }
  dispose() {
    const gl = this.gl;
    gl.deleteShader(this.vertexShader);
    gl.deleteShader(this.fragmentShader);
    gl.deleteProgram(this.program);
    this.uniformLocations.clear();
  }
};
function loadImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const img = document.createElement("img");
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = imageUrl;
    img.crossOrigin = "anonymous";
    img.loading = "eager";
  });
}
function loadVideo(videoUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let playing = false;
    let timeupdate = false;
    let rejected = false;
    video.addEventListener("playing", () => {
      playing = true;
      checkReady();
    }, true);
    video.addEventListener("timeupdate", () => {
      timeupdate = true;
      checkReady();
    }, true);
    video.addEventListener("error", (err) => {
      rejected = true;
      reject(err);
    }, true);
    function checkReady() {
      if (playing && timeupdate && !rejected) resolve(video);
    }
    video.src = videoUrl;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.play();
  });
}
function loadResourceFromUrl(url, isVideo = false) {
  return isVideo ? loadVideo(url) : loadImage(url);
}
function loadResourceFromElement(element) {
  return new Promise((resolve, reject) => {
    if (element instanceof HTMLImageElement ? element.complete : element.readyState >= 3) resolve(element);
    else {
      element.onload = () => resolve(element);
      element.onerror = reject;
    }
  });
}
function rgbToHsv(color) {
  const [r, g, b] = color;
  const max2 = Math.max(r, g, b);
  const min2 = Math.min(r, g, b);
  const v = max2 * 100 / 255;
  if (max2 === min2) return {
    h: 0,
    s: 0,
    v
  };
  const s = (max2 - min2) / max2 * 100;
  let h = 0;
  if (max2 === r) h = 60 * (g - b) / (max2 - min2);
  else if (max2 === g) h = 60 * (2 + (b - r) / (max2 - min2));
  else h = 60 * (4 + (r - g) / (max2 - min2));
  if (h < 0) h += 360;
  return {
    h,
    s,
    v
  };
}
function hsvToRgb(hsv) {
  const h = hsv.h === 360 ? 0 : hsv.h;
  const hi = Math.floor(h / 60) % 6;
  const f = h / 60 - hi;
  const p2 = hsv.v / 100 * (1 - hsv.s / 100) * 255;
  const q = hsv.v / 100 * (1 - f * (hsv.s / 100)) * 255;
  const t = hsv.v / 100 * (1 - (1 - f) * (hsv.s / 100)) * 255;
  const v = hsv.v * 255 / 100;
  return [
    [
      v,
      t,
      p2
    ],
    [
      q,
      v,
      p2
    ],
    [
      p2,
      v,
      t
    ],
    [
      p2,
      q,
      v
    ],
    [
      t,
      p2,
      v
    ],
    [
      v,
      p2,
      q
    ]
  ][hi] ?? [
    v,
    p2,
    q
  ];
}
function rgbToXyz(rgb) {
  const [red, green, blue] = rgb;
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  return [
    r * 0.4124 + g * 0.3576 + b * 0.1805,
    r * 0.2126 + g * 0.7152 + b * 0.0722,
    r * 0.0193 + g * 0.1192 + b * 0.9505
  ];
}
function xyzToRgb(xyz) {
  const [x, y, z] = xyz;
  return [
    (x * 3.2406 - y * 1.5372 - z * 0.4986) * 255,
    (-x * 0.9689 + y * 1.8758 + z * 0.0415) * 255,
    (x * 0.0557 - y * 0.204 + z * 1.057) * 255
  ];
}
var D65 = {
  x: 0.95047,
  y: 1,
  z: 1.0883
};
function fxyz(t) {
  return t > 8856e-6 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}
function xyzToLab(xyz) {
  const [x, y, z] = xyz;
  return [
    116 * fxyz(y / D65.y) - 16,
    500 * (fxyz(x / D65.x) - fxyz(y / D65.y)),
    200 * (fxyz(y / D65.y) - fxyz(z / D65.z))
  ];
}
function labToXyz(lab) {
  const delta = 6 / 29;
  const [l, a, b] = lab;
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  return [
    fx > delta ? D65.x * fx * fx * fx : (fx - 16 / 116) * 3 * delta * delta * D65.x,
    fy > delta ? D65.y * fy * fy * fy : (fy - 16 / 116) * 3 * delta * delta * D65.y,
    fz > delta ? D65.z * fz * fz * fz : (fz - 16 / 116) * 3 * delta * delta * D65.z
  ];
}
function rgbToLab(rgb) {
  return xyzToLab(rgbToXyz(rgb));
}
function labToRgb(lab) {
  return xyzToRgb(labToXyz(lab));
}
function channelToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function srgbToOkLab(rgb) {
  const [red, green, blue] = rgb;
  const linearRed = channelToLinear(red);
  const linearGreen = channelToLinear(green);
  const linearBlue = channelToLinear(blue);
  const l = Math.cbrt(0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue);
  const m = Math.cbrt(0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue);
  const s = Math.cbrt(0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}
function yToLStar(y) {
  if (y <= 216 / 24389) return y * (24389 / 27);
  return Math.cbrt(y) * 116 - 16;
}
function lStar(rgb) {
  const [r, g, b] = rgb;
  return yToLStar(0.2126 * channelToLinear(r / 255) + 0.7152 * channelToLinear(g / 255) + 0.0722 * channelToLinear(b / 255));
}
function paletteRgbLStarIsDark(rgb) {
  return lStar(rgb) <= 40;
}
function paletteRgbLStarIsLight(rgb) {
  return lStar(rgb) >= 60;
}
function rgbLStarIsDark(rgb) {
  return lStar(rgb) <= 50;
}
function distanceSquared(a, b) {
  const [ax, ay, az] = a;
  const [bx, by, bz] = b;
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 1831565813 >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function seedFromHistogram(entries) {
  let hash = 2166136261;
  for (const { color, count } of entries) for (const value of [...color, count]) {
    hash ^= Math.round(value) & 65535;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
function isNotNearWhite(color) {
  return color.some((channel) => channel <= 250);
}
function filterOrFallback(entries, predicate) {
  const filtered = entries.filter(predicate);
  return filtered.length > 0 ? filtered : [...entries];
}
function clampRgb(color) {
  return color.map((channel) => Math.min(255, Math.max(0, channel)));
}
function groupColors(entries) {
  const grouped = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const key = `${entry.color[0]},${entry.color[1]},${entry.color[2]}`;
    const existing = grouped.get(key);
    if (existing) existing.count += entry.count;
    else grouped.set(key, {
      color: [...entry.color],
      count: entry.count
    });
  }
  return [...grouped.values()];
}
function toLabEntries(entries) {
  return entries.map((entry) => ({
    color: rgbToLab(entry.color),
    count: entry.count
  }));
}
function colorsEqual(a, b) {
  return a.every((value, i) => value === b[i]);
}
function findNearestCenterIndex(color, centers) {
  let nearestIndex = 0;
  let minDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centers.length; i++) {
    const dist = distanceSquared(color, centers[i]);
    if (dist < minDist) {
      nearestIndex = i;
      minDist = dist;
    }
  }
  return nearestIndex;
}
function findFarthestColor(entries, centers) {
  let farthest = [
    0,
    0,
    0
  ];
  let maxDistance = Number.NEGATIVE_INFINITY;
  for (const { color } of entries) {
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const center of centers) {
      const dist = distanceSquared(color, center);
      if (dist < nearestDistance) nearestDistance = dist;
    }
    if (nearestDistance > maxDistance) {
      maxDistance = nearestDistance;
      farthest = color;
    }
  }
  return farthest;
}
function kMeansPlusPlusCenters(entries, clusterCount, random) {
  const firstIndex = Math.floor(random() * entries.length);
  const selectedIndices = /* @__PURE__ */ new Set([firstIndex]);
  const centers = [entries[firstIndex].color];
  for (let i = 1; i < clusterCount; i++) {
    let accumulated = 0;
    const accDistances = new Float64Array(entries.length);
    for (let vectorId = 0; vectorId < entries.length; vectorId++) {
      const target = entries[vectorId].color;
      let minDistanceSquared = distanceSquared(centers[0], target);
      for (let clusterIdx = 1; clusterIdx < i; clusterIdx++) {
        const current = distanceSquared(centers[clusterIdx], target);
        if (current < minDistanceSquared) minDistanceSquared = current;
      }
      accumulated += minDistanceSquared * entries[vectorId].count;
      accDistances[vectorId] = accumulated;
    }
    if (accumulated <= Number.EPSILON) {
      const nextIndex = entries.findIndex((_, index) => !selectedIndices.has(index));
      if (nextIndex < 0) break;
      selectedIndices.add(nextIndex);
      centers.push(entries[nextIndex].color);
      continue;
    }
    const targetPoint = random() * accumulated;
    for (let vectorId = 0; vectorId < entries.length; vectorId++) if (!selectedIndices.has(vectorId) && accDistances[vectorId] >= targetPoint) {
      selectedIndices.add(vectorId);
      centers.push(entries[vectorId].color);
      break;
    }
    if (centers.length === i) {
      const nextIndex = entries.findIndex((_, index) => !selectedIndices.has(index));
      if (nextIndex < 0) break;
      selectedIndices.add(nextIndex);
      centers.push(entries[nextIndex].color);
    }
  }
  return centers;
}
function kMeansCluster(entries, numClusters, useKMeansPP, random) {
  const clusterCount = Math.min(numClusters, entries.length);
  if (clusterCount <= 0) return [];
  let centers;
  if (useKMeansPP) centers = kMeansPlusPlusCenters(entries, clusterCount, random);
  else {
    const shuffled = entries.map((entry) => entry.color);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    centers = shuffled.slice(0, clusterCount);
  }
  const assignments = new Int32Array(entries.length);
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 250) {
    changed = false;
    iterations++;
    for (let i = 0; i < entries.length; i++) assignments[i] = findNearestCenterIndex(entries[i].color, centers);
    for (let i = 0; i < clusterCount; i++) {
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let weight = 0;
      for (let e = 0; e < entries.length; e++) {
        if (assignments[e] !== i) continue;
        const { color, count } = entries[e];
        sumX += color[0] * count;
        sumY += color[1] * count;
        sumZ += color[2] * count;
        weight += count;
      }
      if (weight === 0) {
        centers[i] = findFarthestColor(entries, centers);
        changed = true;
        continue;
      }
      const newCenter = [
        sumX / weight,
        sumY / weight,
        sumZ / weight
      ];
      if (!colorsEqual(newCenter, centers[i])) {
        centers[i] = newCenter;
        changed = true;
      }
    }
  }
  return centers;
}
function createThemeColor(sourceColors, ignoreWhite = false, toLab = false, random = createRandom(seedFromHistogram(sourceColors))) {
  let entries = [...sourceColors];
  if (ignoreWhite && entries.length > 1) entries = filterOrFallback(entries, (entry) => isNotNearWhite(entry.color));
  if (toLab) entries = toLabEntries(entries);
  entries = groupColors(entries);
  const first = kMeansCluster(entries, 1, false, random)[0] ?? [
    0,
    0,
    0
  ];
  const color = clampRgb(toLab ? labToRgb(first) : first);
  return {
    color,
    colorIsDark: rgbLStarIsDark(color)
  };
}
function createKMeansPalette(sourceColors, clusterCount, themeColor, ignoreWhite = false, toLab = false, useKMeansPP = false, intent = "accent", random = createRandom(seedFromHistogram(sourceColors))) {
  let effectiveIgnoreWhite = ignoreWhite;
  let effectiveUseKMeansPP = useKMeansPP;
  if (sourceColors.length === 1) {
    effectiveIgnoreWhite = false;
    effectiveUseKMeansPP = false;
  }
  const colorIsDark = themeColor.colorIsDark;
  let entries = filterOrFallback(sourceColors, (entry) => {
    if (intent === "dominant") return !effectiveIgnoreWhite || isNotNearWhite(entry.color);
    if (colorIsDark) return paletteRgbLStarIsDark(entry.color);
    if (!effectiveIgnoreWhite) return paletteRgbLStarIsLight(entry.color);
    return paletteRgbLStarIsLight(entry.color) && isNotNearWhite(entry.color);
  });
  if (toLab) entries = toLabEntries(entries);
  entries = groupColors(entries);
  const dominantColors = kMeansCluster(entries, clusterCount, effectiveUseKMeansPP, random).map((center) => clampRgb(toLab ? labToRgb(center) : center));
  const palette = [];
  for (let i = 0; i < clusterCount; i++) palette.push(dominantColors.length > 0 ? [...dominantColors[i % dominantColors.length]] : [
    0,
    0,
    0
  ]);
  return {
    palette,
    paletteIsDark: colorIsDark,
    themeColor
  };
}
var MAX_COLOR_DEPTH = 8;
var OctreeNode = class OctreeNode2 {
  owner;
  parentNode;
  indexInParent;
  children = [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null
  ];
  childCount = 0;
  leafNodeCount = 0;
  sampleCount = 0;
  redSum = 0;
  greenSum = 0;
  blueSum = 0;
  constructor(owner, parentNode, indexInParent) {
    this.owner = owner;
    this.parentNode = parentNode;
    this.indexInParent = indexInParent;
  }
  get averageColor() {
    if (this.sampleCount === 0) return [
      0,
      0,
      0
    ];
    return [
      this.redSum / this.sampleCount,
      this.greenSum / this.sampleCount,
      this.blueSum / this.sampleCount
    ];
  }
  addColor(red, green, blue, depth, sampleCount) {
    this.sampleCount += sampleCount;
    this.redSum += red * sampleCount;
    this.greenSum += green * sampleCount;
    this.blueSum += blue * sampleCount;
    if (depth === MAX_COLOR_DEPTH) {
      if (this.leafNodeCount === 0) this.leafNodeCount = 1;
      return;
    }
    const bitShift = 7 - depth;
    const childIndex = (red >> bitShift & 1) << 2 | (green >> bitShift & 1) << 1 | blue >> bitShift & 1;
    let childNode = this.children[childIndex];
    if (!childNode) {
      childNode = new OctreeNode2(this.owner, this, childIndex);
      this.children[childIndex] = childNode;
      this.childCount++;
      this.owner.registerNodeAtDepth(childNode, depth);
    }
    const previousLeafNodeCount = childNode.leafNodeCount;
    childNode.addColor(red, green, blue, depth + 1, sampleCount);
    this.leafNodeCount += childNode.leafNodeCount - previousLeafNodeCount;
  }
  collectPaletteColors(result) {
    if (this.leafNodeCount === 0) return;
    if (this.childCount === 0) {
      result.push({
        color: this.averageColor,
        sampleCount: this.sampleCount
      });
      return;
    }
    for (const child of this.children) child?.collectPaletteColors(result);
  }
  mergeChildrenIntoThisNode() {
    if (this.childCount === 0 || this.leafNodeCount <= 1) return;
    const previousLeafNodeCount = this.leafNodeCount;
    this.children.fill(null);
    this.childCount = 0;
    this.leafNodeCount = this.sampleCount > 0 ? 1 : 0;
    const leafReduction = previousLeafNodeCount - this.leafNodeCount;
    let parentNode = this.parentNode;
    while (parentNode) {
      parentNode.leafNodeCount -= leafReduction;
      parentNode = parentNode.parentNode;
    }
  }
  /** 合并会把整棵子树摘掉，被摘掉的节点仍留在深度索引里，需要显式排除。 */
  isAttachedToRoot() {
    let currentNode = this;
    while (currentNode.parentNode) {
      if (currentNode.parentNode.children[currentNode.indexInParent] !== currentNode) return false;
      currentNode = currentNode.parentNode;
    }
    return true;
  }
};
var OctreePaletteQuantizer = class {
  rootNode = new OctreeNode(this, null, -1);
  nodesByDepth = Array.from({ length: MAX_COLOR_DEPTH }, () => []);
  registerNodeAtDepth(node, depth) {
    this.nodesByDepth[depth].push(node);
  }
  addColor(color, sampleCount) {
    if (sampleCount <= 0) return;
    this.rootNode.addColor(color[0] & 255, color[1] & 255, color[2] & 255, 0, sampleCount);
  }
  getPalette(maxColorCount) {
    if (maxColorCount <= 0 || this.rootNode.leafNodeCount === 0) return [];
    const paletteColors = [];
    this.rootNode.collectPaletteColors(paletteColors);
    if (paletteColors.length <= maxColorCount) return paletteColors.map((entry) => entry.color);
    paletteColors.sort((left, right) => {
      const bySampleCount = right.sampleCount - left.sampleCount;
      if (bySampleCount !== 0) return bySampleCount;
      if (left.color[0] !== right.color[0]) return left.color[0] - right.color[0];
      if (left.color[1] !== right.color[1]) return left.color[1] - right.color[1];
      return left.color[2] - right.color[2];
    });
    return paletteColors.slice(0, Math.min(maxColorCount, paletteColors.length)).map((entry) => entry.color);
  }
  reduceToColorCount(targetColorCount) {
    if (targetColorCount <= 0) return;
    let remainingLeafReduction = this.rootNode.leafNodeCount - targetColorCount;
    if (remainingLeafReduction <= 0) return;
    for (let depth = 6; depth >= 0 && remainingLeafReduction > 0; depth--) {
      const nodesAtDepth = this.nodesByDepth[depth];
      nodesAtDepth.sort((left, right) => {
        const byLeafCount = left.leafNodeCount - right.leafNodeCount;
        if (byLeafCount !== 0) return byLeafCount;
        return left.sampleCount - right.sampleCount;
      });
      for (let i = 0; i < nodesAtDepth.length && remainingLeafReduction > 0; i++) {
        const candidate = nodesAtDepth[i];
        if (candidate.childCount === 0) continue;
        const leafReduction = candidate.leafNodeCount - 1;
        if (leafReduction <= 0) continue;
        if (leafReduction > remainingLeafReduction) continue;
        remainingLeafReduction -= leafReduction;
        candidate.mergeChildrenIntoThisNode();
      }
    }
    while (this.rootNode.leafNodeCount > targetColorCount) {
      const candidate = this.findBestMergeCandidate();
      if (!candidate) break;
      candidate.mergeChildrenIntoThisNode();
    }
  }
  findBestMergeCandidate() {
    let bestCandidate = null;
    let bestLeafReduction = Number.POSITIVE_INFINITY;
    let bestSampleCount = Number.POSITIVE_INFINITY;
    for (let depth = 6; depth >= 0; depth--) for (const candidate of this.nodesByDepth[depth]) {
      if (!candidate.isAttachedToRoot()) continue;
      if (candidate.childCount === 0) continue;
      const leafReduction = candidate.leafNodeCount - 1;
      if (leafReduction <= 0) continue;
      if (leafReduction < bestLeafReduction || leafReduction === bestLeafReduction && candidate.sampleCount < bestSampleCount) {
        bestCandidate = candidate;
        bestLeafReduction = leafReduction;
        bestSampleCount = candidate.sampleCount;
      }
    }
    return bestCandidate;
  }
};
function createOctTreePalette(sourceColors, clusterCount, themeColor = createThemeColor(sourceColors, false, true), ignoreWhite = false, intent = "accent") {
  const quantizer = new OctreePaletteQuantizer();
  const effectiveIgnoreWhite = sourceColors.length === 1 ? false : ignoreWhite;
  const filteredEntries = sourceColors.filter((entry) => {
    const [r, g, b] = entry.color;
    if (effectiveIgnoreWhite && r > 250 && g > 250 && b > 250) return false;
    if (intent === "dominant") return true;
    return themeColor.colorIsDark ? paletteRgbLStarIsDark(entry.color) : paletteRgbLStarIsLight(entry.color);
  });
  const entries = filteredEntries.length > 0 ? filteredEntries : sourceColors;
  for (const entry of entries) quantizer.addColor(entry.color, entry.count);
  quantizer.reduceToColorCount(clusterCount);
  const quantizeResult = quantizer.getPalette(clusterCount);
  let palette;
  if (quantizeResult.length < clusterCount) {
    palette = [];
    for (let i = 0; i < clusterCount; i++) palette.push(quantizeResult.length > 0 ? [...quantizeResult[i % quantizeResult.length]] : [
      0,
      0,
      0
    ]);
  } else palette = quantizeResult;
  return {
    palette,
    paletteIsDark: themeColor.colorIsDark,
    themeColor
  };
}
function calculateSpatialDiversity(palette) {
  if (palette.length === 0) return 0;
  const labVectors = palette.map(rgbToLab);
  let centroidL = 0;
  let centroidA = 0;
  let centroidB = 0;
  for (const [l, a, b] of labVectors) {
    centroidL += l;
    centroidA += a;
    centroidB += b;
  }
  centroidL /= labVectors.length;
  centroidA /= labVectors.length;
  centroidB /= labVectors.length;
  let sumSquaredDistances = 0;
  for (const [l, a, b] of labVectors) {
    const dl = l - centroidL;
    const da = a - centroidA;
    const db = b - centroidB;
    sumSquaredDistances += dl * dl + da * da + db * db;
  }
  return sumSquaredDistances / labVectors.length;
}
function countDistinctColors(palette) {
  return new Set(palette.map((color) => color.join(","))).size;
}
function createAutoPalette(sourceColors, clusterCount, ignoreWhite = false, toLab = false, useKMeansPP = false, intent = "accent") {
  const random = createRandom(seedFromHistogram(sourceColors));
  const themeColor = createThemeColor(sourceColors, ignoreWhite, toLab, random);
  const kmeansResult = createKMeansPalette(sourceColors, clusterCount, themeColor, ignoreWhite, toLab, useKMeansPP, intent, random);
  const octTreeResult = createOctTreePalette(sourceColors, clusterCount, themeColor, ignoreWhite, intent);
  const kMeansDistinct = countDistinctColors(kmeansResult.palette);
  const octTreeDistinct = countDistinctColors(octTreeResult.palette);
  if (kMeansDistinct !== octTreeDistinct) return kMeansDistinct > octTreeDistinct ? kmeansResult : octTreeResult;
  const kMeansDiversity = calculateSpatialDiversity(kmeansResult.palette);
  const octTreeDiversity = calculateSpatialDiversity(octTreeResult.palette);
  if (intent === "dominant" || kmeansResult.paletteIsDark) return kMeansDiversity >= octTreeDiversity ? kmeansResult : octTreeResult;
  return kMeansDiversity <= octTreeDiversity || octTreeDiversity === 0 ? kmeansResult : octTreeResult;
}
function createOffscreenCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
var DEFAULT_SAMPLE_SIZE = 64;
function toImageData(source, sampleSize) {
  if (source instanceof ImageData) return source;
  const [sourceWidth, sourceHeight] = source instanceof HTMLVideoElement ? [source.videoWidth, source.videoHeight] : source instanceof HTMLImageElement ? [source.naturalWidth, source.naturalHeight] : [source.width, source.height];
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const scale = Math.min(1, Math.max(1, Math.floor(sampleSize)) / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const ctx = createOffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
function buildColorHistogram(source, sampleSize = DEFAULT_SAMPLE_SIZE) {
  const imageData = toImageData(source, sampleSize);
  if (!imageData) return [];
  const { data } = imageData;
  const counts = /* @__PURE__ */ new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts, ([key, count]) => {
    return {
      color: [
        key >> 16 & 255,
        key >> 8 & 255,
        key & 255
      ],
      count
    };
  });
}
function createPaletteFromImage(source, clusterCount, options = {}) {
  const normalizedClusterCount = Math.max(0, Math.floor(clusterCount));
  const { algorithm = "auto", ignoreWhite = false, toLab = false, useKMeansPP = false, intent = "accent", sampleSize } = options;
  const entries = buildColorHistogram(source, sampleSize);
  if (entries.length === 0) return {
    palette: Array.from({ length: normalizedClusterCount }, () => [
      0,
      0,
      0
    ]),
    paletteIsDark: true,
    themeColor: {
      color: [
        0,
        0,
        0
      ],
      colorIsDark: true
    }
  };
  switch (algorithm) {
    case "kmeans":
      return createKMeansPalette(entries, normalizedClusterCount, createThemeColor(entries, ignoreWhite, toLab), ignoreWhite, toLab, useKMeansPP, intent);
    case "octtree":
      return createOctTreePalette(entries, normalizedClusterCount, createThemeColor(entries, ignoreWhite, true), ignoreWhite, intent);
    default:
      return createAutoPalette(entries, normalizedClusterCount, ignoreWhite, toLab, useKMeansPP, intent);
  }
}
var webgl1Support;
var highpFragmentSupport;
function withProbeContext(contextId, probe = () => true) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext(contextId);
    if (!gl) return false;
    try {
      return probe(gl);
    } finally {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    return false;
  }
}
function isWebGL1Supported() {
  if (webgl1Support === void 0) webgl1Support = withProbeContext("webgl");
  return webgl1Support;
}
function isHighpFragmentSupported() {
  if (highpFragmentSupport === void 0) highpFragmentSupport = withProbeContext("webgl", (gl) => {
    return (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ?? 0) > 0;
  });
  return highpFragmentSupport;
}
var isolation_frag_default = "// WebGL1 port of Storyteller-Studios/Cirrus' IsolationEffect.\n// The random values and flow parameters are re-rolled per album by\n// IsolationRenderer, so a cover gets a stable composition while different\n// covers do not share a layout.\n//\n// Everything that is constant for a whole draw call -- the sRGB to OkLab\n// conversion of the four colors, and the randomised flow parameters -- is\n// computed on the CPU and uploaded as uniforms instead of being recomputed per\n// fragment.\n//\n// highp is required rather than optional: u_time grows without bound and the\n// noise hash amplifies it by ~44000, which mediump's 10 significant bits cannot\n// carry. IsolationRenderer.isSupported() refuses environments without highp\n// fragment precision, so this shader simply fails to compile there instead of\n// silently rendering a broken picture.\nprecision highp float;\n\nuniform vec2 u_resolution;\nuniform float u_time;\n// The four gradient colors, already converted to OkLab by the CPU.\nuniform vec3 u_colors[4];\nuniform vec3 u_random;\n// x = ripple frequency, y = ripple amplitude divisor,\n// z = flow speed (sign carries the direction), w = gradient axis tilt in radians\nuniform vec4 u_flowParams;\n// Extra jitter added to the noise-driven gradient angle, in radians.\nuniform float u_angleJitter;\nuniform bool u_enableLightWave;\nuniform bool u_enableDithering;\n\nconst float PI = 3.141592653589793;\n\nvec2 rotatePoint(vec2 point, float angle) {\n	float sine = sin(angle);\n	float cosine = cos(angle);\n	return vec2(\n		point.x * cosine - point.y * sine,\n		point.x * sine + point.y * cosine\n	);\n}\n\nvec2 gradientHash(vec2 point) {\n	return fract(\n		sin(\n			vec2(\n				dot(point, vec2(127.1, 311.7)),\n				dot(point, vec2(269.5, 183.3))\n			)\n		) * 43758.5453\n	);\n}\n\nfloat gradientNoise(vec2 point) {\n	vec2 cell = floor(point);\n	vec2 offset = fract(point);\n	vec2 eased = offset * offset * (3.0 - 2.0 * offset);\n	float lower = mix(\n		dot(-1.0 + 2.0 * gradientHash(cell), offset),\n		dot(-1.0 + 2.0 * gradientHash(cell + vec2(1.0, 0.0)), offset - vec2(1.0, 0.0)),\n		eased.x\n	);\n	float upper = mix(\n		dot(-1.0 + 2.0 * gradientHash(cell + vec2(0.0, 1.0)), offset - vec2(0.0, 1.0)),\n		dot(-1.0 + 2.0 * gradientHash(cell + vec2(1.0, 1.0)), offset - vec2(1.0, 1.0)),\n		eased.x\n	);\n	return 0.5 + 0.5 * mix(lower, upper, eased.y);\n}\n\nfloat encodeSrgb(float channel) {\n	return channel <= 0.0031308\n		? 12.92 * channel\n		: 1.055 * pow(max(channel, 0.0), 1.0 / 2.4) - 0.055;\n}\n\nvec3 okLabToSrgb(vec3 color) {\n	float lRoot = color.x + 0.3963377774 * color.y + 0.2158037573 * color.z;\n	float mRoot = color.x - 0.1055613458 * color.y - 0.0638541728 * color.z;\n	float sRoot = color.x - 0.0894841775 * color.y - 1.2914855480 * color.z;\n	float l = lRoot * lRoot * lRoot;\n	float m = mRoot * mRoot * mRoot;\n	float s = sRoot * sRoot * sRoot;\n	vec3 linearColor = vec3(\n		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,\n		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,\n		-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s\n	);\n	return vec3(\n		encodeSrgb(linearColor.r),\n		encodeSrgb(linearColor.g),\n		encodeSrgb(linearColor.b)\n	);\n}\n\nvec3 applyLightWave(vec3 okLabColor, vec2 uv) {\n	vec2 point = -1.0 + 1.5 * uv;\n	float x = point.x;\n	float y = point.y;\n	float time = u_time * 0.2;\n	float yPhase = y / 0.3;\n	float xPhase = x / 0.2;\n	float timeWarp = cos(sin(time) * 2.0) * 0.1;\n	float movement = (x + y) * 0.001 + timeWarp + sin(x * 0.01);\n	float wave1 =\n		sin(yPhase + 2.0 * time + u_random.x) * 0.5 -\n		yPhase -\n		xPhase * 0.5;\n	float wave2 = cos(\n		wave1 +\n			sin(movement + time) +\n			sin(y * 0.025 + time) +\n			sin((x + y) * 0.01) * 3.0 +\n			u_random.y\n	);\n	float wave3 = abs(\n		sin(\n			wave2 +\n				cos(yPhase + time + xPhase + wave2) +\n				cos(xPhase) +\n				sin(x * 0.001) +\n				u_random.z\n		)\n	);\n	// \u53D6\u8272\u4E0D\u518D\u538B\u6697\uFF0C\u7EAF\u767D\u5C01\u9762\u7684 L \u80FD\u5230 1.0\uFF0C\u4E58\u5B8C\u5FC5\u987B\u94B3\u4F4F\uFF1A\u8BA9 L \u6EA2\u51FA\u518D\u9760\u672B\u5C3E\u7684\n	// RGB \u94B3\u4F4D\u6536\u573A\u4F1A\u9010\u901A\u9053\u524A\u9876\uFF0C\u628A\u8272\u76F8\u4E5F\u4E00\u8D77\u6539\u6389\n	okLabColor.x = clamp(okLabColor.x * (1.1 - 0.1 * wave3), 0.0, 1.0);\n	return okLabToSrgb(okLabColor);\n}\n\nfloat interleavedGradientNoise(vec2 position) {\n	return fract(\n		52.9829189 * fract(dot(position, vec2(0.06711056, 0.00583715)))\n	);\n}\n\nvec3 screenSpaceDither(vec2 screenPosition) {\n	vec2 position = screenPosition + u_random.xy * 97.0;\n	vec3 noise = vec3(\n		interleavedGradientNoise(position),\n		interleavedGradientNoise(position + vec2(17.0, 59.0)),\n		interleavedGradientNoise(position + vec2(71.0, 23.0))\n	);\n	return (noise - 0.5) / 255.0;\n}\n\nvoid main() {\n	vec2 uv = gl_FragCoord.xy / u_resolution;\n	vec2 gradientPoint = uv - 0.5;\n	float degree = gradientNoise(\n		vec2(\n			u_time * 0.1 + u_random.x * 0.07,\n			gradientPoint.x * gradientPoint.y + u_random.y * 0.07\n		)\n	);\n	float noiseAngle = ((degree - 0.5) * 720.0 + 180.0) * PI / 180.0;\n	gradientPoint = rotatePoint(gradientPoint, noiseAngle + u_angleJitter);\n\n	float frequency = u_flowParams.x;\n	float amplitude = u_flowParams.y;\n	float speed = u_time * u_flowParams.z;\n	gradientPoint.x += sin(gradientPoint.y * frequency + speed) / amplitude;\n	gradientPoint.y +=\n		sin(gradientPoint.x * frequency * 1.5 + speed) / (amplitude * 0.5);\n\n	float rotatedX = rotatePoint(gradientPoint, u_flowParams.w).x;\n	float horizontal = smoothstep(-0.3, 0.2, rotatedX);\n	vec3 okLabColor = mix(\n		mix(u_colors[0], u_colors[1], horizontal),\n		mix(u_colors[2], u_colors[3], horizontal),\n		1.0 - smoothstep(-0.3, 0.5, gradientPoint.y)\n	);\n	vec3 color = u_enableLightWave\n		? applyLightWave(okLabColor, uv)\n		: okLabToSrgb(okLabColor);\n\n	if (u_enableDithering) {\n		color += screenSpaceDither(gl_FragCoord.xy);\n	}\n\n	gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);\n}\n";
var isolation_vert_default = "attribute vec2 a_position;\n\nvoid main() {\n	gl_Position = vec4(a_position, 0.0, 1.0);\n}\n";
var PALETTE_TRANSITION_MS = 1e3;
var TAU = Math.PI * 2;
var DEG_TO_RAD = Math.PI / 180;
var COLOR_COUNT = 4;
var ALBUM_RETRY_TIMES = 5;
var DEFAULT_COLORS = [
  [
    0.09,
    0.09,
    0.11
  ],
  [
    0.13,
    0.13,
    0.16
  ],
  [
    0.07,
    0.07,
    0.09
  ],
  [
    0.11,
    0.11,
    0.13
  ]
];
function lerp(from, to, amount) {
  return from + (to - from) * amount;
}
var DEFAULT_OKLAB_COLORS = new Float32Array(DEFAULT_COLORS.flatMap(srgbToOkLab));
var IsolationRenderer = class IsolationRenderer2 extends BaseRenderer {
  /**
  * 新建实例时采用的默认选项。
  *
  * 该对象也可作为配置界面的初始值；实例创建后的调整统一走
  * {@link setOptions}。
  */
  static defaultOptions = {
    lightWave: false,
    dithering: true,
    paletteAlgorithm: "auto"
  };
  /** 当前环境是否支持该渲染器，选择渲染器前应先问一句。 */
  static isSupported() {
    return isWebGL1Supported() && isHighpFragmentSupported();
  }
  gl;
  program;
  quadBuffer;
  contextLost = false;
  _disposed = false;
  options = { ...IsolationRenderer2.defaultOptions };
  tickHandle = 0;
  lastTickTime = 0;
  lastFrameTime = 0;
  frameTime = 0;
  maxFPS = 30;
  paused = false;
  staticMode = false;
  targetWidth = 0;
  targetHeight = 0;
  currentWidth = 0;
  currentHeight = 0;
  albumRequestId = 0;
  albumSource;
  /**
  * 调色板过渡已经过的毫秒数。
  *
  * 这里刻意不用 `performance.now()`：过渡必须和渲染时钟走同一套时间，否则
  * 暂停、静态模式或限帧的时候过渡进度会和画面对不上。
  */
  paletteTransitionElapsed = PALETTE_TRANSITION_MS;
  /** 过渡起点、终点与当前帧的颜色，均为 OkLab，四个颜色首尾相接。 */
  fromColors = new Float32Array(DEFAULT_OKLAB_COLORS);
  toColors = new Float32Array(DEFAULT_OKLAB_COLORS);
  colorBuffer = new Float32Array(DEFAULT_OKLAB_COLORS);
  /** 取色结果的暂存区，避免每次换封面都新建数组。 */
  nextColors = /* @__PURE__ */ new Float32Array(12);
  randomValues = /* @__PURE__ */ new Float32Array(3);
  /**
  * 渐变流动参数，依次是波纹频率、波纹幅度、流动速度（已含方向）与渐变轴倾角
  * （弧度）。原实现是在片元着色器里用随机哈希现算的，但它们对整个 draw call
  * 都是常量，挪到 CPU 上由 {@link rollRandomParameters} 随机一次即可 —— 这里
  * 含随机量，若真的逐帧重算，画面会逐帧剧烈跳变。
  */
  flowParams = /* @__PURE__ */ new Float32Array(4);
  /** 渐变轴叠加在噪声角度上的抖动，单位弧度，同样是整帧常量。 */
  angleJitter = 0;
  paletteOrder = new Uint8Array(COLOR_COUNT);
  constructor(canvas) {
    super(canvas);
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power"
    });
    if (!gl) {
      this.disconnectResizeObserver();
      throw new Error("WebGL not supported");
    }
    this.gl = gl;
    try {
      this.rollRandomParameters();
      this.initializeGLResources();
    } catch (e) {
      this.program?.dispose();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      this.disconnectResizeObserver();
      throw e;
    }
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.requestTick();
  }
  initializeGLResources() {
    const gl = this.gl;
    this.program = new GLProgram(gl, isolation_vert_default, isolation_frag_default, "isolation");
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("Failed to create quad buffer");
    this.quadBuffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,
      -1,
      1,
      -1,
      -1,
      1,
      -1,
      1,
      1,
      -1,
      1,
      1
    ]), gl.STATIC_DRAW);
    const position = this.program.attrs.a_position;
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  }
  onContextLost = (event) => {
    event.preventDefault();
    this.contextLost = true;
    if (this.tickHandle) {
      cancelAnimationFrame(this.tickHandle);
      this.tickHandle = 0;
    }
  };
  onContextRestored = () => {
    if (this._disposed) return;
    try {
      this.initializeGLResources();
    } catch (e) {
      this.program?.dispose();
      console.error("Failed to restore WebGL resources", e);
      return;
    }
    this.contextLost = false;
    this.currentWidth = 0;
    this.currentHeight = 0;
    this.resetFrameClock();
    this.requestTick();
  };
  /** 重掷整张封面期间保持不变的随机参数，避免画面逐帧跳变。 */
  rollRandomParameters() {
    for (let i = 0; i < this.randomValues.length; i++) this.randomValues[i] = Math.random() * TAU;
    const direction = Math.random() < 0.5 ? -1 : 1;
    this.flowParams[0] = lerp(4.5, 5.5, Math.random());
    this.flowParams[1] = lerp(22, 29, Math.random());
    this.flowParams[2] = lerp(0.65, 0.85, Math.random()) * direction;
    this.flowParams[3] = (-5 + (Math.random() - 0.5) * 12) * DEG_TO_RAD;
    this.angleJitter = (Math.random() - 0.5) * 0.3;
    for (let i = 0; i < this.paletteOrder.length; i++) this.paletteOrder[i] = i;
    for (let i = this.paletteOrder.length - 1; i > 0; i--) {
      const swapIndex = Math.floor(Math.random() * (i + 1));
      [this.paletteOrder[i], this.paletteOrder[swapIndex]] = [this.paletteOrder[swapIndex], this.paletteOrder[i]];
    }
  }
  /** 调整渲染器选项，会立即生效。 */
  setOptions(patch) {
    const previous = this.options;
    const next = {
      lightWave: patch.lightWave ?? previous.lightWave,
      dithering: patch.dithering ?? previous.dithering,
      paletteAlgorithm: patch.paletteAlgorithm ?? previous.paletteAlgorithm
    };
    const algorithmChanged = next.paletteAlgorithm !== previous.paletteAlgorithm;
    this.options = next;
    if (algorithmChanged && this.albumSource) this.updatePaletteFromSource(this.albumSource, true);
    this.requestTick();
  }
  updatePaletteFromSource(source, immediate = false) {
    let palette;
    try {
      palette = createPaletteFromImage(source, COLOR_COUNT, {
        algorithm: this.options.paletteAlgorithm,
        intent: "dominant"
      }).palette;
    } catch (err) {
      console.warn("Failed to extract palette from album", err);
      return;
    }
    for (let i = 0; i < COLOR_COUNT; i++) {
      const [red, green, blue] = palette[this.paletteOrder[i]];
      this.nextColors.set(srgbToOkLab([
        red / 255,
        green / 255,
        blue / 255
      ]), i * 3);
    }
    this.transitionToColors(this.nextColors, immediate);
    this.requestTick();
  }
  transitionToColors(next, immediate) {
    if (immediate) this.fromColors.set(next);
    else {
      this.updateColorBuffer();
      this.fromColors.set(this.colorBuffer);
    }
    this.toColors.set(next);
    this.paletteTransitionElapsed = immediate ? PALETTE_TRANSITION_MS : 0;
  }
  /** 按当前过渡进度就地更新 {@link colorBuffer}，不产生任何中间数组。 */
  updateColorBuffer() {
    if (this.paletteTransitionElapsed >= PALETTE_TRANSITION_MS) {
      this.colorBuffer.set(this.toColors);
      return;
    }
    const progress = this.paletteTransitionElapsed / PALETTE_TRANSITION_MS;
    const eased = progress * progress * (3 - 2 * progress);
    for (let i = 0; i < this.colorBuffer.length; i++) this.colorBuffer[i] = lerp(this.fromColors[i], this.toColors[i], eased);
  }
  checkIfResize() {
    if (this.targetWidth === this.currentWidth && this.targetHeight === this.currentHeight) return;
    super.onResize(this.targetWidth, this.targetHeight);
    this.currentWidth = this.targetWidth;
    this.currentHeight = this.targetHeight;
    this.gl.viewport(0, 0, this.targetWidth, this.targetHeight);
  }
  onRedraw(frameTime, frameDelta) {
    this.checkIfResize();
    if (this.currentWidth <= 0 || this.currentHeight <= 0) return false;
    if (this.paletteTransitionElapsed < PALETTE_TRANSITION_MS) this.paletteTransitionElapsed += frameDelta;
    this.updateColorBuffer();
    this.program.use();
    this.program.setUniform2f("u_resolution", this.currentWidth, this.currentHeight);
    this.program.setUniform1f("u_time", frameTime / 1e3);
    this.program.setUniform3fv("u_colors[0]", this.colorBuffer);
    this.program.setUniform3fv("u_random", this.randomValues);
    this.program.setUniform4f("u_flowParams", this.flowParams[0], this.flowParams[1], this.flowParams[2], this.flowParams[3]);
    this.program.setUniform1f("u_angleJitter", this.angleJitter);
    this.program.setUniform1i("u_enableLightWave", this.options.lightWave ? 1 : 0);
    this.program.setUniform1i("u_enableDithering", this.options.dithering ? 1 : 0);
    const gl = this.gl;
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.paletteTransitionElapsed >= PALETTE_TRANSITION_MS;
  }
  onTick(tickTime) {
    this.tickHandle = 0;
    if (this.paused || this._disposed || this.contextLost) return;
    const interval = 1e3 / this.maxFPS;
    const delta = tickTime - this.lastTickTime;
    if (delta < interval) {
      this.requestTick();
      return;
    }
    if (Number.isNaN(this.lastFrameTime)) this.lastFrameTime = tickTime;
    const frameDelta = Math.min(tickTime - this.lastFrameTime, 250);
    this.lastFrameTime = tickTime;
    this.lastTickTime = tickTime - delta % interval;
    this.frameTime += frameDelta * this.flowSpeed;
    if (!(this.onRedraw(this.frameTime, frameDelta) && this.staticMode)) this.requestTick();
    else this.lastFrameTime = NaN;
  }
  onTickBinded = this.onTick.bind(this);
  requestTick() {
    if (this._disposed || this.paused || this.contextLost) return;
    if (!(this.maxFPS > 0)) return;
    if (this.tickHandle === 0) this.tickHandle = requestAnimationFrame(this.onTickBinded);
  }
  onResize(width, height) {
    this.targetWidth = Math.ceil(width);
    this.targetHeight = Math.ceil(height);
    this.requestTick();
  }
  setStaticMode(enable) {
    this.staticMode = enable;
    this.resetFrameClock();
    this.requestTick();
  }
  setFPS(fps) {
    this.maxFPS = fps;
    this.resetFrameClock();
    this.requestTick();
  }
  pause() {
    if (this.tickHandle) {
      cancelAnimationFrame(this.tickHandle);
      this.tickHandle = 0;
    }
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.resetFrameClock();
    this.requestTick();
  }
  resetFrameClock() {
    const now = performance.now();
    this.lastFrameTime = now;
    this.lastTickTime = now;
  }
  /**
  * 该次 `setAlbum` 是否还是最新的一次。
  *
  * 与 `MeshGradientRenderer` 不同，这里不看 `contextLost`：取色全在 CPU
  * 上做，上下文丢了也照样能把调色板算完存着，等上下文恢复直接就能画。
  */
  isCurrentAlbumRequest(requestId) {
    return !this._disposed && requestId === this.albumRequestId;
  }
  async setAlbum(albumSource, isVideo) {
    const requestId = ++this.albumRequestId;
    if (albumSource === void 0 || typeof albumSource === "string" && albumSource.trim().length === 0) {
      this.albumSource = void 0;
      this.transitionToColors(DEFAULT_OKLAB_COLORS, false);
      this.requestTick();
      return;
    }
    let source = null;
    let remainRetryTimes = ALBUM_RETRY_TIMES;
    while (!source && remainRetryTimes > 0) try {
      source = typeof albumSource === "string" ? await loadResourceFromUrl(albumSource, isVideo) : await loadResourceFromElement(albumSource);
    } catch (error) {
      if (!this.isCurrentAlbumRequest(requestId)) return;
      remainRetryTimes--;
      console.warn(`failed on loading album resource, retrying (${remainRetryTimes})`, {
        albumSource,
        error
      });
    }
    if (!this.isCurrentAlbumRequest(requestId)) return;
    if (!source) {
      console.error("Failed to load album resource", albumSource);
      return;
    }
    this.albumSource = source;
    this.rollRandomParameters();
    this.updatePaletteFromSource(source);
  }
  setLowFreqVolume(_volume) {
  }
  setHasLyric(_hasLyric) {
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this.tickHandle) {
      cancelAnimationFrame(this.tickHandle);
      this.tickHandle = 0;
    }
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.program.dispose();
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    super.dispose();
  }
};
function clamp(x, min2, max2) {
  return Math.min(Math.max(x, min2), max2);
}
function clamp01(x) {
  return clamp(x, 0, 1);
}
function clampPositive(x) {
  return Math.max(0, x);
}
function blurImage(imageData, radius, quality) {
  const pixels = imageData.data;
  const width = imageData.width;
  const height = imageData.height;
  let rsum;
  let gsum;
  let bsum;
  let asum;
  let x;
  let y;
  let i;
  let p2;
  let p1;
  let p22;
  let yp;
  let yi;
  let yw;
  const wm = width - 1;
  const hm = height - 1;
  const rad1x = radius + 1;
  const divx = radius + rad1x;
  const rad1y = radius + 1;
  const div2 = 1 / (divx * (radius + rad1y));
  const r = [];
  const g = [];
  const b = [];
  const a = [];
  const vmin = [];
  const vmax = [];
  while (quality-- > 0) {
    yw = yi = 0;
    for (y = 0; y < height; y++) {
      rsum = pixels[yw] * rad1x;
      gsum = pixels[yw + 1] * rad1x;
      bsum = pixels[yw + 2] * rad1x;
      asum = pixels[yw + 3] * rad1x;
      for (i = 1; i <= radius; i++) {
        p2 = yw + ((i > wm ? wm : i) << 2);
        rsum += pixels[p2++];
        gsum += pixels[p2++];
        bsum += pixels[p2++];
        asum += pixels[p2];
      }
      for (x = 0; x < width; x++) {
        r[yi] = rsum;
        g[yi] = gsum;
        b[yi] = bsum;
        a[yi] = asum;
        if (y === 0) {
          vmin[x] = Math.min(x + rad1x, wm) << 2;
          vmax[x] = Math.max(x - radius, 0) << 2;
        }
        p1 = yw + vmin[x];
        p22 = yw + vmax[x];
        rsum += pixels[p1++] - pixels[p22++];
        gsum += pixels[p1++] - pixels[p22++];
        bsum += pixels[p1++] - pixels[p22++];
        asum += pixels[p1] - pixels[p22];
        yi++;
      }
      yw += width << 2;
    }
    for (x = 0; x < width; x++) {
      yp = x;
      rsum = r[yp] * rad1y;
      gsum = g[yp] * rad1y;
      bsum = b[yp] * rad1y;
      asum = a[yp] * rad1y;
      for (i = 1; i <= radius; i++) {
        yp += i > hm ? 0 : width;
        rsum += r[yp];
        gsum += g[yp];
        bsum += b[yp];
        asum += a[yp];
      }
      yi = x << 2;
      for (y = 0; y < height; y++) {
        pixels[yi] = rsum * div2 + 0.5 | 0;
        pixels[yi + 1] = gsum * div2 + 0.5 | 0;
        pixels[yi + 2] = bsum * div2 + 0.5 | 0;
        pixels[yi + 3] = asum * div2 + 0.5 | 0;
        if (x === 0) {
          vmin[y] = Math.min(y + rad1y, hm) * width;
          vmax[y] = Math.max(y - radius, 0) * width;
        }
        p1 = x + vmin[y];
        p22 = x + vmax[y];
        rsum += r[p1] - r[p22];
        gsum += g[p1] - g[p22];
        bsum += b[p1] - b[p22];
        asum += a[p1] - a[p22];
        yi += width << 2;
      }
    }
  }
}
var p = (cx, cy, x, y, ur = 0, vr = 0, up = 1, vp = 1) => Object.freeze({
  cx,
  cy,
  x,
  y,
  ur,
  vr,
  up,
  vp
});
var preset = (width, height, conf) => Object.freeze({
  width,
  height,
  conf
});
var CONTROL_POINT_PRESETS = [
  preset(5, 5, [
    p(0, 0, -1, -1, 0, 0, 1, 1),
    p(1, 0, -0.5, -1, 0, 0, 1, 1),
    p(2, 0, 0, -1, 0, 0, 1, 1),
    p(3, 0, 0.5, -1, 0, 0, 1, 1),
    p(4, 0, 1, -1, 0, 0, 1, 1),
    p(0, 1, -1, -0.5, 0, 0, 1, 1),
    p(1, 1, -0.5, -0.5, 0, 0, 1, 1),
    p(2, 1, -0.0052029684413368305, -0.6131420587090777, 0, 0, 1, 1),
    p(3, 1, 0.5884227308309977, -0.3990805107556692, 0, 0, 1, 1),
    p(4, 1, 1, -0.5, 0, 0, 1, 1),
    p(0, 2, -1, 0, 0, 0, 1, 1),
    p(1, 2, -0.4210024670505933, -0.11895058380429502, 0, 0, 1, 1),
    p(2, 2, -0.1019613423315412, -0.023812118047224606, 0, -47, 0.629, 0.849),
    p(3, 2, 0.40275125660925437, -0.06345314544600389, 0, 0, 1, 1),
    p(4, 2, 1, 0, 0, 0, 1, 1),
    p(0, 3, -1, 0.5, 0, 0, 1, 1),
    p(1, 3, 0.06801958477287173, 0.5205913248960121, -31, -45, 1, 1),
    p(2, 3, 0.21446469120128908, 0.29331610114301043, 6, -56, 0.566, 1.321),
    p(3, 3, 0.5, 0.5, 0, 0, 1, 1),
    p(4, 3, 1, 0.5, 0, 0, 1, 1),
    p(0, 4, -1, 1, 0, 0, 1, 1),
    p(1, 4, -0.31378372841550195, 1, 0, 0, 1, 1),
    p(2, 4, 0.26153633255328046, 1, 0, 0, 1, 1),
    p(3, 4, 0.5, 1, 0, 0, 1, 1),
    p(4, 4, 1, 1, 0, 0, 1, 1)
  ]),
  preset(4, 4, [
    p(0, 0, -1, -1, 0, 0, 1, 1),
    p(1, 0, -0.33333333333333337, -1, 0, 0, 1, 1),
    p(2, 0, 0.33333333333333326, -1, 0, 0, 1, 1),
    p(3, 0, 1, -1, 0, 0, 1, 1),
    p(0, 1, -1, -0.04495399932657351, 0, 0, 1, 1),
    p(1, 1, -0.24056117520129328, -0.22465999020104, 0, 0, 1, 1),
    p(2, 1, 0.334758885767489, -0.00531297192779423, 0, 0, 1, 1),
    p(3, 1, 0.9989920470678106, -0.3382976020775408, 8, 0, 0.566, 1.792),
    p(0, 2, -1, 0.33333333333333326, 0, 0, 1, 1),
    p(1, 2, -0.3425497314639411, -27501607956947893e-21, 0, 0, 1, 1),
    p(2, 2, 0.3321437945812673, 0.1981776353859399, 0, 0, 1, 1),
    p(3, 2, 1, 0.0766118180296832, 0, 0, 1, 1),
    p(0, 3, -1, 1, 0, 0, 1, 1),
    p(1, 3, -0.33333333333333337, 1, 0, 0, 1, 1),
    p(2, 3, 0.33333333333333326, 1, 0, 0, 1, 1),
    p(3, 3, 1, 1, 0, 0, 1, 1)
  ]),
  preset(4, 4, [
    p(0, 0, -1, -1, 0, 0, 1, 2.075),
    p(1, 0, -0.33333333333333337, -1, 0, 0, 1, 1),
    p(2, 0, 0.33333333333333326, -1, 0, 0, 1, 1),
    p(3, 0, 1, -1, 0, 0, 1, 1),
    p(0, 1, -1, -0.4545779491139603, 0, 0, 1, 1),
    p(1, 1, -0.33333333333333337, -0.33333333333333337, 0, 0, 1, 1),
    p(2, 1, 0.0889403142626457, -0.6025711180694033, -32, 45, 1, 1),
    p(3, 1, 1, -0.33333333333333337, 0, 0, 1, 1),
    p(0, 2, -1, -0.07402408608567845, 1, 0, 1, 0.094),
    p(1, 2, -0.2719422694359541, 0.09775369930903222, 25, -18, 1.321, 0),
    p(2, 2, 0.19877414408395877, 0.4307383294587789, 48, -40, 0.755, 0.975),
    p(3, 2, 1, 0.33333333333333326, -37, 0, 1, 1),
    p(0, 3, -1, 1, 0, 0, 1, 1),
    p(1, 3, -0.33333333333333337, 1, 0, 0, 1, 1),
    p(2, 3, 0.5125850864305672, 1, -20, -18, 0, 1.604),
    p(3, 3, 1, 1, 0, 0, 1, 1)
  ]),
  preset(5, 5, [
    p(0, 0, -1, -1, 0, 0, 1, 1),
    p(1, 0, -0.4501953125, -1, 0, 55, 1, 2.075),
    p(2, 0, 0.1953125, -1, 0, 0, 1, 1),
    p(3, 0, 0.4580078125, -1, 0, -25, 1, 1),
    p(4, 0, 1, -1, 0, 0, 1, 1),
    p(0, 1, -1, -0.2514475377525607, -16, 0, 2.327, 0.943),
    p(1, 1, -0.55859375, -0.6609325945787148, 47, 0, 2.358, 0.377),
    p(2, 1, 0.232421875, -0.5244375756366635, -66, -25, 1.855, 1.164),
    p(3, 1, 0.685546875, -0.3753706470552125, 0, 0, 1, 1),
    p(4, 1, 1, -0.6699125300354287, 0, 0, 1, 1),
    p(0, 2, -1, 0.035910396862284255, 0, 0, 1, 1),
    p(1, 2, -0.4921875, 0.005378616309457018, 90, 23, 1, 1.981),
    p(2, 2, 0.021484375, -0.1365043639066228, 0, 42, 1, 1),
    p(3, 2, 0.4765625, 0.05925822904974043, -30, 0, 1.95, 0.44),
    p(4, 2, 1, 0.251428847823418, 0, 0, 1, 1),
    p(0, 3, -1, 0.6968336464764276, -68, 0, 1, 0.786),
    p(1, 3, -0.6904296875, 0.5890744209958608, -68, 0, 1, 1),
    p(2, 3, 0.1845703125, 0.3879238667654693, 61, 0, 1, 1),
    p(3, 3, 0.60546875, 0.4633553246018661, -47, -59, 0.849, 1.73),
    p(4, 3, 1, 0.6214021886400309, -33, 0, 0.377, 1.604),
    p(0, 4, -1, 1, 0, 0, 1, 1),
    p(1, 4, -0.5, 1, 0, -73, 1, 1),
    p(2, 4, -0.3271484375, 1, 0, -24, 0.314, 2.704),
    p(3, 4, 0.5, 1, 0, 0, 1, 1),
    p(4, 4, 1, 1, 0, 0, 1, 1)
  ]),
  preset(5, 5, [
    p(0, 0, -1, -1),
    p(1, 0, -0.6393, -1, 0, 0, 1, 2.3884),
    p(2, 0, 0, -1),
    p(3, 0, 0.5, -1),
    p(4, 0, 1, -1),
    p(0, 1, -1, -0.2301),
    p(1, 1, -0.6934, -0.331, 0, -0.7188, 1, 1.063),
    p(2, 1, -82e-4, -0.6814, -0.2583, 0, 1.0964, 1),
    p(3, 1, 0.5836, -0.531, 0.7029, 0, 1.5466, 1),
    p(4, 1, 1, -0.6407),
    p(0, 2, -1, 0.2973, 0, 0, 1.8352, 1),
    p(1, 2, -0.4082, 0.0602),
    p(2, 2, -0.1803, -0.3646, -0.2998, 0, 1.1513, 1),
    p(3, 2, 0.477, -0.1027, 0.8903, -0.1882, 1.0807, 0.8551),
    p(4, 2, 1, -0.2973),
    p(0, 3, -1, 0.7628, 0, 0, 2.3868, 1),
    p(1, 3, -0.2525, 0.4814, -0.8406, -1.6199, 1.4093, 1.2215),
    p(2, 3, 0.3607, 0.2814, -1.0713, -0.0529, 1.0025, 0.7611),
    p(3, 3, 0.4885, 0.623, 0, 0.8184, 1, 1.2876),
    p(4, 3, 1, 0.5),
    p(0, 4, -1, 1),
    p(1, 4, -0.4033, 1),
    p(2, 4, 0.2672, 1),
    p(3, 4, 0.5967, 1),
    p(4, 4, 1, 1)
  ]),
  preset(5, 5, [
    p(0, 0, -1, -1),
    p(1, 0, -0.2197, -1),
    p(2, 0, 0.0197, -1),
    p(3, 0, 0.8033, -1),
    p(4, 0, 1, -1),
    p(0, 1, -1, -0.5451),
    p(1, 1, -0.4885, -0.4035, -1.0246, -0.2268, 1.1936, 0.8005),
    p(2, 1, -0.1213, -0.2867, 0, -0.6981, 1, 0.809),
    p(3, 1, 0.3246, -0.5628, 0, -1.2188, 1, 1.044),
    p(4, 1, 1, -0.3292),
    p(0, 2, -1, 0.1416),
    p(1, 2, -0.341, -0.0142, 0, -0.4004, 1, 1.1293),
    p(2, 2, -0.0393, -0.023, 0.2915, -0.373, 1.044, 0.9879),
    p(3, 2, 0.3148, -0.0673, -0.7853, -0.8962, 1.4709, 1.0247),
    p(4, 2, 1, 0.1912),
    p(0, 3, -1, 0.5),
    p(1, 3, -0.2689, 0.2743, 0.3404, -0.5248, 1.0184, 0.4391),
    p(2, 3, 0.0721, 0.269, 0.5302, 0.1244, 0.6723, 0.3225),
    p(3, 3, 0.4148, 0.3894, -0.6977, -0.6783, 0.8094, 0.9247),
    p(4, 3, 1, 0.446),
    p(0, 4, -1, 1),
    p(1, 4, -0.7311, 1),
    p(2, 4, 0.323, 1),
    p(3, 4, 0.6393, 1),
    p(4, 4, 1, 1)
  ])
];
var randomRange = (min2, max2) => Math.random() * (max2 - min2) + min2;
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
function smoothifyControlPoints(conf, w, h, iterations = 2, factor = 0.5, factorIterationModifier = 0.1) {
  let grid = [];
  let f = factor;
  for (let j = 0; j < h; j++) {
    grid[j] = [];
    for (let i = 0; i < w; i++) grid[j][i] = conf[j * w + i];
  }
  const kernel = [
    [
      1,
      2,
      1
    ],
    [
      2,
      4,
      2
    ],
    [
      1,
      2,
      1
    ]
  ];
  const kernelSum = 16;
  for (let iter = 0; iter < iterations; iter++) {
    const newGrid = [];
    for (let j = 0; j < h; j++) {
      newGrid[j] = [];
      for (let i = 0; i < w; i++) {
        if (i === 0 || i === w - 1 || j === 0 || j === h - 1) {
          newGrid[j][i] = grid[j][i];
          continue;
        }
        let sumX = 0;
        let sumY = 0;
        let sumUR = 0;
        let sumVR = 0;
        let sumUP = 0;
        let sumVP = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const weight = kernel[dj + 1][di + 1];
          const nb = grid[j + dj][i + di];
          sumX += nb.x * weight;
          sumY += nb.y * weight;
          sumUR += nb.ur * weight;
          sumVR += nb.vr * weight;
          sumUP += nb.up * weight;
          sumVP += nb.vp * weight;
        }
        const avgX = sumX / kernelSum;
        const avgY = sumY / kernelSum;
        const avgUR = sumUR / kernelSum;
        const avgVR = sumVR / kernelSum;
        const avgUP = sumUP / kernelSum;
        const avgVP = sumVP / kernelSum;
        const cur = grid[j][i];
        const newX = cur.x * (1 - f) + avgX * f;
        const newY = cur.y * (1 - f) + avgY * f;
        const newUR = cur.ur * (1 - f) + avgUR * f;
        const newVR = cur.vr * (1 - f) + avgVR * f;
        const newUP = cur.up * (1 - f) + avgUP * f;
        const newVP = cur.vp * (1 - f) + avgVP * f;
        newGrid[j][i] = p(i, j, newX, newY, newUR, newVR, newUP, newVP);
      }
    }
    grid = newGrid;
    f = clamp01(f + factorIterationModifier);
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) conf[j * w + i] = grid[j][i];
}
function noise(x, y) {
  return fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
}
function fract(x) {
  return x - Math.floor(x);
}
function smoothNoise(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const xf = x - x0;
  const yf = y - y0;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const n00 = noise(x0, y0);
  const n10 = noise(x1, y0);
  const n01 = noise(x0, y1);
  const n11 = noise(x1, y1);
  const nx0 = n00 * (1 - u) + n10 * u;
  const nx1 = n01 * (1 - u) + n11 * u;
  return nx0 * (1 - v) + nx1 * v;
}
function computeNoiseGradient(perlinFn, x, y, epsilon = 1e-3) {
  const n1 = perlinFn(x + epsilon, y);
  const n2 = perlinFn(x - epsilon, y);
  const n3 = perlinFn(x, y + epsilon);
  const n4 = perlinFn(x, y - epsilon);
  const dx = (n1 - n2) / (2 * epsilon);
  const dy = (n3 - n4) / (2 * epsilon);
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return [dx / len, dy / len];
}
function generateControlPoints(width, height, variationFraction = randomRange(0.4, 0.6), normalOffset = randomRange(0.3, 0.6), blendFactor = 0.8, smoothIters = Math.floor(randomRange(3, 5)), smoothFactor = randomRange(0.2, 0.3), smoothModifier = randomRange(-0.1, -0.05)) {
  const w = width ?? Math.floor(randomRange(3, 6));
  const h = height ?? Math.floor(randomRange(3, 6));
  const conf = [];
  const dx = w === 1 ? 0 : 2 / (w - 1);
  const dy = h === 1 ? 0 : 2 / (h - 1);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const baseX = (w === 1 ? 0 : i / (w - 1)) * 2 - 1;
    const baseY = (h === 1 ? 0 : j / (h - 1)) * 2 - 1;
    const isBorder = i === 0 || i === w - 1 || j === 0 || j === h - 1;
    const pertX = isBorder ? 0 : randomRange(-variationFraction * dx, variationFraction * dx);
    const pertY = isBorder ? 0 : randomRange(-variationFraction * dy, variationFraction * dy);
    let x = baseX + pertX;
    let y = baseY + pertY;
    const ur = isBorder ? 0 : randomRange(-60, 60);
    const vr = isBorder ? 0 : randomRange(-60, 60);
    const up = isBorder ? 1 : randomRange(0.8, 1.2);
    const vp = isBorder ? 1 : randomRange(0.8, 1.2);
    if (!isBorder) {
      const uNorm = (baseX + 1) / 2;
      const vNorm = (baseY + 1) / 2;
      const [nx, ny] = computeNoiseGradient(smoothNoise, uNorm, vNorm, 1e-3);
      let offsetX = nx * normalOffset;
      let offsetY = ny * normalOffset;
      const weight = smoothstep(0, 1, Math.min(uNorm, 1 - uNorm, vNorm, 1 - vNorm));
      offsetX *= weight;
      offsetY *= weight;
      x = x * (1 - blendFactor) + (x + offsetX) * blendFactor;
      y = y * (1 - blendFactor) + (y + offsetY) * blendFactor;
    }
    conf.push(p(i, j, x, y, ur, vr, up, vp));
  }
  smoothifyControlPoints(conf, w, h, smoothIters, smoothFactor, smoothModifier);
  return preset(w, h, conf);
}
var mesh_frag_default = "precision mediump float;\n\nvarying vec3 v_color;\nvarying vec2 v_uv;\nuniform sampler2D u_texture;\nuniform float u_volume;\nuniform float u_alpha;\nuniform float u_sinAngle;\nuniform float u_cosAngle;\n\n// \u9884\u8BA1\u7B97\u5E38\u91CF\nconst float INV_255 = 1.0 / 255.0;\nconst float HALF_INV_255 = 0.5 / 255.0;\nconst float GRADIENT_NOISE_A = 52.9829189;\nconst vec2 GRADIENT_NOISE_B = vec2(0.06711056, 0.00583715);\n\nfloat gradientNoise(in vec2 uv) {\n    return fract(GRADIENT_NOISE_A * fract(dot(uv, GRADIENT_NOISE_B)));\n}\n\nvoid main() {\n    float volumeEffect = u_volume * 2.0;\n\n    float dither = INV_255 * gradientNoise(gl_FragCoord.xy) - HALF_INV_255;\n\n    vec2 centeredUV = v_uv - vec2(0.2);\n\n    vec2 rotatedUV = vec2(\n        u_cosAngle * centeredUV.x - u_sinAngle * centeredUV.y,\n        u_sinAngle * centeredUV.x + u_cosAngle * centeredUV.y\n    );\n\n    vec2 finalUV = rotatedUV * max(0.001, 1.0 - volumeEffect) + vec2(0.5);\n    \n    vec4 result = texture2D(u_texture, finalUV);\n    \n    float alphaVolumeFactor = u_alpha * max(0.5, 1.0 - u_volume * 0.5);\n    result.rgb *= v_color * alphaVolumeFactor;\n    result.a *= alphaVolumeFactor;\n    \n    result.rgb += vec3(dither);\n    \n    float dist = distance(v_uv, vec2(0.5));\n    float vignette = smoothstep(0.8, 0.3, dist);\n    float mask = 0.6 + vignette * 0.4;\n    result.rgb *= mask;\n    \n    gl_FragColor = result;\n}\n";
var mesh_vert_default = "precision mediump float;\n\nattribute vec2 a_pos;\nattribute vec3 a_color;\nattribute vec2 a_uv;\nvarying vec3 v_color;\nvarying vec2 v_uv;\n\nuniform float u_aspect;\n\nvoid main() {\n    v_color = a_color;\n    v_uv = a_uv;\n    vec2 pos = a_pos;\n    if (u_aspect > 1.0) {\n        pos.y *= u_aspect;\n    } else {\n        pos.x /= u_aspect;\n    }\n    gl_Position = vec4(pos, 0.0, 1.0);\n}\n";
var quadVertShader = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
    v_uv = a_pos * 0.5 + 0.5;
}
`;
var quadFragShader = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_alpha;
void main() {
    vec4 color = texture2D(u_texture, v_uv);
    gl_FragColor = vec4(color.rgb, color.a * u_alpha);
}
`;
function easeInOutSine(x) {
  return -(Math.cos(Math.PI * x) - 1) / 2;
}
var Mesh = class {
  gl;
  attrPos;
  attrColor;
  attrUV;
  vertexWidth = 0;
  vertexHeight = 0;
  vertexBuffer;
  indexBuffer;
  vertexData;
  indexData;
  vertexIndexLength = 0;
  wireFrame = false;
  constructor(gl, attrPos, attrColor, attrUV) {
    this.gl = gl;
    this.attrPos = attrPos;
    this.attrColor = attrColor;
    this.attrUV = attrUV;
    const vertexBuf = gl.createBuffer();
    if (!vertexBuf) throw new Error("Failed to create vertex buffer");
    this.vertexBuffer = vertexBuf;
    const indexBuf = gl.createBuffer();
    if (!indexBuf) throw new Error("Failed to create index buffer");
    this.indexBuffer = indexBuf;
    this.bind();
    this.vertexData = /* @__PURE__ */ new Float32Array(0);
    this.indexData = /* @__PURE__ */ new Uint16Array(0);
    this.resize(2, 2);
    this.update();
  }
  setWireFrame(enable) {
    this.wireFrame = enable;
    this.resize(this.vertexWidth, this.vertexHeight);
  }
  setVertexPos(vx, vy, x, y) {
    const idx = (vx + vy * this.vertexWidth) * 7;
    if (idx >= this.vertexData.length - 1) {
      console.warn("Vertex position out of range", idx, this.vertexData.length);
      return;
    }
    this.vertexData[idx] = x;
    this.vertexData[idx + 1] = y;
  }
  setVertexColor(vx, vy, r, g, b) {
    const idx = (vx + vy * this.vertexWidth) * 7 + 2;
    if (idx >= this.vertexData.length - 2) {
      console.warn("Vertex color out of range", idx, this.vertexData.length);
      return;
    }
    this.vertexData[idx] = r;
    this.vertexData[idx + 1] = g;
    this.vertexData[idx + 2] = b;
  }
  setVertexUV(vx, vy, x, y) {
    const idx = (vx + vy * this.vertexWidth) * 7 + 5;
    if (idx >= this.vertexData.length - 1) {
      console.warn("Vertex UV out of range", idx, this.vertexData.length);
      return;
    }
    this.vertexData[idx] = x;
    this.vertexData[idx + 1] = y;
  }
  setVertexData(vx, vy, x, y, r, g, b, u, v) {
    const idx = (vx + vy * this.vertexWidth) * 7;
    if (idx >= this.vertexData.length - 6) {
      console.warn("Vertex data out of range", idx, this.vertexData.length);
      return;
    }
    const data = this.vertexData;
    data[idx] = x;
    data[idx + 1] = y;
    data[idx + 2] = r;
    data[idx + 3] = g;
    data[idx + 4] = b;
    data[idx + 5] = u;
    data[idx + 6] = v;
  }
  getVertexIndexLength() {
    return this.vertexIndexLength;
  }
  draw() {
    const gl = this.gl;
    if (this.wireFrame) gl.drawElements(gl.LINES, this.vertexIndexLength, gl.UNSIGNED_SHORT, 0);
    else gl.drawElements(gl.TRIANGLES, this.vertexIndexLength, gl.UNSIGNED_SHORT, 0);
  }
  resize(vertexWidth, vertexHeight) {
    this.vertexWidth = vertexWidth;
    this.vertexHeight = vertexHeight;
    this.vertexIndexLength = vertexWidth * vertexHeight * 6;
    if (this.wireFrame) this.vertexIndexLength = vertexWidth * vertexHeight * 10;
    const vertexData = new Float32Array(vertexWidth * vertexHeight * 7);
    const indexData = new Uint16Array(this.vertexIndexLength);
    this.vertexData = vertexData;
    this.indexData = indexData;
    for (let y = 0; y < vertexHeight; y++) for (let x = 0; x < vertexWidth; x++) {
      const px = x / (vertexWidth - 1) * 2 - 1;
      const py = y / (vertexHeight - 1) * 2 - 1;
      this.setVertexPos(x, y, px || 0, py || 0);
      this.setVertexColor(x, y, 1, 1, 1);
      this.setVertexUV(x, y, x / (vertexWidth - 1), y / (vertexHeight - 1));
    }
    for (let y = 0; y < vertexHeight - 1; y++) for (let x = 0; x < vertexWidth - 1; x++) if (this.wireFrame) {
      const idx = (y * vertexWidth + x) * 10;
      indexData[idx] = y * vertexWidth + x;
      indexData[idx + 1] = y * vertexWidth + x + 1;
      indexData[idx + 2] = y * vertexWidth + x + 1;
      indexData[idx + 3] = (y + 1) * vertexWidth + x;
      indexData[idx + 4] = (y + 1) * vertexWidth + x;
      indexData[idx + 5] = (y + 1) * vertexWidth + x + 1;
      indexData[idx + 6] = (y + 1) * vertexWidth + x + 1;
      indexData[idx + 7] = y * vertexWidth + x + 1;
      indexData[idx + 8] = y * vertexWidth + x;
      indexData[idx + 9] = (y + 1) * vertexWidth + x;
    } else {
      const idx = (y * vertexWidth + x) * 6;
      indexData[idx] = y * vertexWidth + x;
      indexData[idx + 1] = y * vertexWidth + x + 1;
      indexData[idx + 2] = (y + 1) * vertexWidth + x;
      indexData[idx + 3] = y * vertexWidth + x + 1;
      indexData[idx + 4] = (y + 1) * vertexWidth + x + 1;
      indexData[idx + 5] = (y + 1) * vertexWidth + x;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexData, gl.STATIC_DRAW);
  }
  bind() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    if (this.attrPos !== void 0) {
      gl.vertexAttribPointer(this.attrPos, 2, gl.FLOAT, false, 28, 0);
      gl.enableVertexAttribArray(this.attrPos);
    }
    if (this.attrColor !== void 0) {
      gl.vertexAttribPointer(this.attrColor, 3, gl.FLOAT, false, 28, 8);
      gl.enableVertexAttribArray(this.attrColor);
    }
    if (this.attrUV !== void 0) {
      gl.vertexAttribPointer(this.attrUV, 2, gl.FLOAT, false, 28, 20);
      gl.enableVertexAttribArray(this.attrUV);
    }
  }
  update() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData, gl.DYNAMIC_DRAW);
  }
  dispose() {
    this.gl.deleteBuffer(this.vertexBuffer);
    this.gl.deleteBuffer(this.indexBuffer);
  }
};
var ControlPoint = class {
  color = Vec3.fromValues(1, 1, 1);
  location = Vec2.fromValues(0, 0);
  uTangent = Vec2.fromValues(0, 0);
  vTangent = Vec2.fromValues(0, 0);
  _uRot = 0;
  _vRot = 0;
  _uScale = 1;
  _vScale = 1;
  constructor() {
    Object.seal(this);
  }
  get uRot() {
    return this._uRot;
  }
  get vRot() {
    return this._vRot;
  }
  set uRot(value) {
    this._uRot = value;
    this.updateUTangent();
  }
  set vRot(value) {
    this._vRot = value;
    this.updateVTangent();
  }
  get uScale() {
    return this._uScale;
  }
  get vScale() {
    return this._vScale;
  }
  set uScale(value) {
    this._uScale = value;
    this.updateUTangent();
  }
  set vScale(value) {
    this._vScale = value;
    this.updateVTangent();
  }
  updateUTangent() {
    this.uTangent[0] = Math.cos(this._uRot) * this._uScale;
    this.uTangent[1] = Math.sin(this._uRot) * this._uScale;
  }
  updateVTangent() {
    this.vTangent[0] = -Math.sin(this._vRot) * this._vScale;
    this.vTangent[1] = Math.cos(this._vRot) * this._vScale;
  }
};
var H = Mat4.fromValues(2, -2, 1, 1, -3, 3, -2, -1, 0, 0, 1, 0, 1, 0, 0, 0);
var H_T = Mat4.clone(H).transpose();
function meshCoefficients(p00, p01, p10, p11, axis, output = Mat4.create()) {
  const l = (p2) => p2.location[axis];
  const u = (p2) => p2.uTangent[axis];
  const v = (p2) => p2.vTangent[axis];
  output[0] = l(p00);
  output[1] = l(p01);
  output[2] = v(p00);
  output[3] = v(p01);
  output[4] = l(p10);
  output[5] = l(p11);
  output[6] = v(p10);
  output[7] = v(p11);
  output[8] = u(p00);
  output[9] = u(p01);
  output[10] = 0;
  output[11] = 0;
  output[12] = u(p10);
  output[13] = u(p11);
  output[14] = 0;
  output[15] = 0;
  return output;
}
function colorCoefficients(p00, p01, p10, p11, axis, output = Mat4.create()) {
  const c = (p2) => p2.color[axis];
  output.fill(0);
  output[0] = c(p00);
  output[1] = c(p01);
  output[4] = c(p10);
  output[5] = c(p11);
  return output;
}
var Map2D = class {
  _width = 0;
  _height = 0;
  _data = [];
  constructor(width, height) {
    this.resize(width, height);
    Object.seal(this);
  }
  resize(width, height) {
    this._width = width;
    this._height = height;
    this._data = new Array(width * height).fill(0);
  }
  set(x, y, value) {
    this._data[x + y * this._width] = value;
  }
  get(x, y) {
    return this._data[x + y * this._width];
  }
  get width() {
    return this._width;
  }
  get height() {
    return this._height;
  }
};
var BHPMesh = class extends Mesh {
  /**
  * 细分级别，越大曲线越平滑，但是性能消耗也越大
  */
  _subDivisions = 10;
  _controlPoints = new Map2D(3, 3);
  constructor(gl, attrPos, attrColor, attrUV) {
    super(gl, attrPos, attrColor, attrUV);
    this.resizeControlPoints(3, 3);
    Object.seal(this);
  }
  setWireFrame(enable) {
    super.setWireFrame(enable);
    this.updateMesh();
  }
  /**
  * 以当前的控制点矩阵大小和细分级别为参考重新设置细分级别，此操作不会重设控制点数据
  * @param subDivisions 细分级别
  */
  resetSubdivition(subDivisions) {
    this._subDivisions = subDivisions;
    super.resize((this._controlPoints.width - 1) * subDivisions, (this._controlPoints.height - 1) * subDivisions);
  }
  /**
  * 重设控制点矩阵尺寸，将会重置所有控制点的颜色和坐标数据
  * 请在调用此方法后重新设置颜色和坐标，并调用 updateMesh 方法更新网格
  * @param width 控制点宽度数量，必须大于等于 2
  * @param height 控制点高度数量，必须大于等于 2
  */
  resizeControlPoints(width, height) {
    if (!(width >= 2 && height >= 2)) throw new Error("Control points must be larger than 3x3 or equal");
    this._controlPoints.resize(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const point = new ControlPoint();
      point.location.x = x / (width - 1) * 2 - 1;
      point.location.y = y / (height - 1) * 2 - 1;
      point.uTangent.x = 2 / (width - 1);
      point.vTangent.y = 2 / (height - 1);
      this._controlPoints.set(x, y, point);
    }
    this.resetSubdivition(this._subDivisions);
  }
  /**
  * 获取指定位置的控制点，然后可以设置颜色和坐标属性
  * 留意颜色属性和坐标属性的值范围均参考 WebGL 的定义
  * 即颜色各个组件取值 [0-1]，坐标取值 [-1, 1]
  * 点的位置以画面左下角为原点 (0,0)
  * @param x 需要获取的控制点的 x 坐标
  * @param y 需要获取的控制点的 y 坐标
  * @returns 控制点对象
  */
  getControlPoint(x, y) {
    return this._controlPoints.get(x, y);
  }
  tempX = Mat4.create();
  tempY = Mat4.create();
  tempR = Mat4.create();
  tempG = Mat4.create();
  tempB = Mat4.create();
  tempXAcc = Mat4.create();
  tempYAcc = Mat4.create();
  tempRAcc = Mat4.create();
  tempGAcc = Mat4.create();
  tempBAcc = Mat4.create();
  tempUx = Vec4.create();
  tempUy = Vec4.create();
  tempUr = Vec4.create();
  tempUg = Vec4.create();
  tempUb = Vec4.create();
  precomputeMatrix(M, output) {
    output.copy(M).transpose();
    Mat4.mul(output, output, H);
    Mat4.mul(output, H_T, output);
    return output;
  }
  /**
  * 更新最终呈现的网格数据，此方法应在所有控制点或细分参数的操作完成后调用
  */
  updateMesh() {
    const subDivM1 = this._subDivisions - 1;
    const tW = subDivM1 * (this._controlPoints.height - 1);
    const tH = subDivM1 * (this._controlPoints.width - 1);
    const controlPointsWidth = this._controlPoints.width;
    const controlPointsHeight = this._controlPoints.height;
    const subDivisions = this._subDivisions;
    const invSubDivM1 = 1 / subDivM1;
    const invTH = 1 / tH;
    const invTW = 1 / tW;
    const normPowers = new Float32Array(subDivisions * 4);
    for (let i = 0; i < subDivisions; i++) {
      const norm = i * invSubDivM1;
      const idx = i * 4;
      normPowers[idx] = norm ** 3;
      normPowers[idx + 1] = norm ** 2;
      normPowers[idx + 2] = norm;
      normPowers[idx + 3] = 1;
    }
    for (let x = 0; x < controlPointsWidth - 1; x++) for (let y = 0; y < controlPointsHeight - 1; y++) {
      const p00 = this._controlPoints.get(x, y);
      const p01 = this._controlPoints.get(x, y + 1);
      const p10 = this._controlPoints.get(x + 1, y);
      const p11 = this._controlPoints.get(x + 1, y + 1);
      meshCoefficients(p00, p01, p10, p11, "x", this.tempX);
      meshCoefficients(p00, p01, p10, p11, "y", this.tempY);
      colorCoefficients(p00, p01, p10, p11, "r", this.tempR);
      colorCoefficients(p00, p01, p10, p11, "g", this.tempG);
      colorCoefficients(p00, p01, p10, p11, "b", this.tempB);
      this.precomputeMatrix(this.tempX, this.tempXAcc);
      this.precomputeMatrix(this.tempY, this.tempYAcc);
      this.precomputeMatrix(this.tempR, this.tempRAcc);
      this.precomputeMatrix(this.tempG, this.tempGAcc);
      this.precomputeMatrix(this.tempB, this.tempBAcc);
      const sX = x / (controlPointsWidth - 1);
      const sY = y / (controlPointsHeight - 1);
      const baseVx = y * subDivisions;
      const baseVy = x * subDivisions;
      for (let u = 0; u < subDivisions; u++) {
        const vxOffset = baseVx + u;
        const uIdx = u * 4;
        this.tempUx[0] = normPowers[uIdx];
        this.tempUx[1] = normPowers[uIdx + 1];
        this.tempUx[2] = normPowers[uIdx + 2];
        this.tempUx[3] = normPowers[uIdx + 3];
        Vec4.transformMat4(this.tempUx, this.tempUx, this.tempXAcc);
        this.tempUy[0] = normPowers[uIdx];
        this.tempUy[1] = normPowers[uIdx + 1];
        this.tempUy[2] = normPowers[uIdx + 2];
        this.tempUy[3] = normPowers[uIdx + 3];
        Vec4.transformMat4(this.tempUy, this.tempUy, this.tempYAcc);
        this.tempUr[0] = normPowers[uIdx];
        this.tempUr[1] = normPowers[uIdx + 1];
        this.tempUr[2] = normPowers[uIdx + 2];
        this.tempUr[3] = normPowers[uIdx + 3];
        Vec4.transformMat4(this.tempUr, this.tempUr, this.tempRAcc);
        this.tempUg[0] = normPowers[uIdx];
        this.tempUg[1] = normPowers[uIdx + 1];
        this.tempUg[2] = normPowers[uIdx + 2];
        this.tempUg[3] = normPowers[uIdx + 3];
        Vec4.transformMat4(this.tempUg, this.tempUg, this.tempGAcc);
        this.tempUb[0] = normPowers[uIdx];
        this.tempUb[1] = normPowers[uIdx + 1];
        this.tempUb[2] = normPowers[uIdx + 2];
        this.tempUb[3] = normPowers[uIdx + 3];
        Vec4.transformMat4(this.tempUb, this.tempUb, this.tempBAcc);
        for (let v = 0; v < subDivisions; v++) {
          const vy = baseVy + v;
          const vIdx = v * 4;
          const v0 = normPowers[vIdx];
          const v1 = normPowers[vIdx + 1];
          const v2 = normPowers[vIdx + 2];
          const v3 = normPowers[vIdx + 3];
          const px = v0 * this.tempUx[0] + v1 * this.tempUx[1] + v2 * this.tempUx[2] + v3 * this.tempUx[3];
          const py = v0 * this.tempUy[0] + v1 * this.tempUy[1] + v2 * this.tempUy[2] + v3 * this.tempUy[3];
          const pr = v0 * this.tempUr[0] + v1 * this.tempUr[1] + v2 * this.tempUr[2] + v3 * this.tempUr[3];
          const pg = v0 * this.tempUg[0] + v1 * this.tempUg[1] + v2 * this.tempUg[2] + v3 * this.tempUg[3];
          const pb = v0 * this.tempUb[0] + v1 * this.tempUb[1] + v2 * this.tempUb[2] + v3 * this.tempUb[3];
          const uvX = sX + v * invTH;
          const uvY = 1 - sY - u * invTW;
          this.setVertexData(vxOffset, vy, px, py, pr, pg, pb, uvX, uvY);
        }
      }
    }
    this.update();
  }
};
var GLTexture = class {
  gl;
  tex;
  constructor(gl, albumImageData) {
    this.gl = gl;
    const albumTexture = gl.createTexture();
    if (!albumTexture) throw new Error("Failed to create texture");
    this.tex = albumTexture;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, albumTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, albumImageData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  }
  bind() {
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
  }
  dispose() {
    this.gl.deleteTexture(this.tex);
  }
};
var MeshGradientRenderer = class extends BaseRenderer {
  /**
  * 当前环境是否支持此渲染器
  */
  static isSupported() {
    return isWebGL1Supported();
  }
  gl;
  contextLost = false;
  albumRequestId = 0;
  albumLoadController;
  lastImageData;
  lastFrameTime = 0;
  frameTime = 0;
  lastTickTime = 0;
  smoothedVolume = 0;
  volume = 0;
  tickHandle = 0;
  maxFPS = 60;
  paused = false;
  staticMode = false;
  mainProgram;
  quadProgram;
  quadBuffer;
  fbo = null;
  fboTexture = null;
  manualControl = false;
  reduceImageSizeCanvas = createOffscreenCanvas(32, 32);
  targetSize = Vec2.fromValues(0, 0);
  currentSize = Vec2.fromValues(0, 0);
  isNoCover = true;
  meshStates = [];
  _disposed = false;
  frameCount = 0;
  lastFPSUpdate = 0;
  currentFPS = 0;
  enablePerformanceMonitoring = false;
  isCurrentAlbumRequest(requestId) {
    return !this._disposed && !this.contextLost && requestId === this.albumRequestId;
  }
  initializeGLResources() {
    const gl = this.gl;
    if (!gl.getExtension("EXT_color_buffer_float")) console.warn("EXT_color_buffer_float not supported");
    if (!gl.getExtension("EXT_float_blend")) console.warn("EXT_float_blend not supported");
    if (!gl.getExtension("OES_texture_float_linear")) console.warn("OES_texture_float_linear not supported");
    if (!gl.getExtension("OES_texture_float")) console.warn("OES_texture_float not supported");
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    this.mainProgram = new GLProgram(gl, mesh_vert_default, mesh_frag_default, "main-program-mg");
    this.quadProgram = new GLProgram(gl, quadVertShader, quadFragShader, "quad-program");
    const quadBuffer = gl.createBuffer();
    if (!quadBuffer) throw new Error("Failed to create quad buffer");
    this.quadBuffer = quadBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,
      -1,
      1,
      -1,
      -1,
      1,
      -1,
      1,
      1,
      -1,
      1,
      1
    ]), gl.STATIC_DRAW);
  }
  createMeshState(imageData) {
    const newMesh = new BHPMesh(this.gl, this.mainProgram.attrs.a_pos, this.mainProgram.attrs.a_color, this.mainProgram.attrs.a_uv);
    newMesh.resetSubdivition(50);
    const chosenPreset = Math.random() > 0.8 ? generateControlPoints(6, 6) : CONTROL_POINT_PRESETS[Math.floor(Math.random() * CONTROL_POINT_PRESETS.length)];
    newMesh.resizeControlPoints(chosenPreset.width, chosenPreset.height);
    const uPower = 2 / (chosenPreset.width - 1);
    const vPower = 2 / (chosenPreset.height - 1);
    for (const cp of chosenPreset.conf) {
      const p2 = newMesh.getControlPoint(cp.cx, cp.cy);
      p2.location.x = cp.x;
      p2.location.y = cp.y;
      p2.uRot = cp.ur * Math.PI / 180;
      p2.vRot = cp.vr * Math.PI / 180;
      p2.uScale = uPower * cp.up;
      p2.vScale = vPower * cp.vp;
    }
    newMesh.updateMesh();
    return {
      mesh: newMesh,
      texture: new GLTexture(this.gl, imageData),
      alpha: 0
    };
  }
  onContextLost = (event) => {
    event.preventDefault();
    this.contextLost = true;
    this.albumLoadController?.abort();
    if (this.tickHandle) {
      cancelAnimationFrame(this.tickHandle);
      this.tickHandle = 0;
    }
  };
  onContextRestored = () => {
    if (this._disposed) return;
    this.contextLost = false;
    this.meshStates = [];
    this.fbo = null;
    this.fboTexture = null;
    this.currentSize = Vec2.fromValues(0, 0);
    this.initializeGLResources();
    this.lastFrameTime = performance.now();
    this.isNoCover = !this.lastImageData;
    if (this.lastImageData) this.meshStates.push(this.createMeshState(this.lastImageData));
    this.requestTick();
  };
  setManualControl(enable) {
    this.manualControl = enable;
  }
  setWireFrame(enable) {
    for (const state of this.meshStates) state.mesh.setWireFrame(enable);
  }
  getControlPoint(x, y) {
    return this.meshStates[this.meshStates.length - 1]?.mesh?.getControlPoint(x, y);
  }
  resizeControlPoints(width, height) {
    this.meshStates[this.meshStates.length - 1]?.mesh?.resizeControlPoints(width, height);
  }
  resetSubdivition(subDivisions) {
    this.meshStates[this.meshStates.length - 1]?.mesh?.resetSubdivition(subDivisions);
  }
  onTick(tickTime) {
    this.tickHandle = 0;
    if (this.paused) return;
    if (this._disposed) return;
    if (this.contextLost) return;
    this.updatePerformanceStats(tickTime);
    const interval = 1e3 / this.maxFPS;
    const delta = tickTime - this.lastTickTime;
    if (delta < interval) {
      this.requestTick();
      return;
    }
    if (Number.isNaN(this.lastFrameTime)) this.lastFrameTime = tickTime;
    const frameDelta = tickTime - this.lastFrameTime;
    this.lastFrameTime = tickTime;
    this.lastTickTime = tickTime - delta % interval;
    this.frameTime += frameDelta * this.flowSpeed;
    if (!(this.onRedraw(this.frameTime, frameDelta) && this.staticMode)) this.requestTick();
    else if (this.staticMode) this.lastFrameTime = NaN;
  }
  checkIfResize() {
    const [tW, tH] = [this.targetSize.x, this.targetSize.y];
    const [cW, cH] = [this.currentSize.x, this.currentSize.y];
    if (tW !== cW || tH !== cH) {
      super.onResize(tW, tH);
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, tW, tH);
      this.currentSize.x = tW;
      this.currentSize.y = tH;
      if (tW > 0 && tH > 0) this.updateFBO(tW, tH);
    }
  }
  updateFBO(width, height) {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.fboTexture) gl.deleteTexture(this.fboTexture);
    this.fboTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  onRedraw(tickTime, delta) {
    const latestMeshState = this.meshStates[this.meshStates.length - 1];
    let canBeStatic = false;
    const deltaFactor = delta / 500;
    if (latestMeshState) {
      latestMeshState.mesh.bind();
      if (this.manualControl) latestMeshState.mesh.updateMesh();
      if (this.isNoCover) {
        let hasActiveStates = false;
        for (let i = this.meshStates.length - 1; i >= 0; i--) {
          const state = this.meshStates[i];
          if (state.alpha <= -0.1) {
            state.mesh.dispose();
            state.texture.dispose();
            this.meshStates.splice(i, 1);
          } else {
            state.alpha = Math.max(-0.1, state.alpha - deltaFactor);
            hasActiveStates = true;
          }
        }
        canBeStatic = !hasActiveStates;
      } else {
        if (latestMeshState.alpha >= 1.1) {
          const deleted = this.meshStates.splice(0, this.meshStates.length - 1);
          for (const state of deleted) {
            state.mesh.dispose();
            state.texture.dispose();
          }
        } else latestMeshState.alpha = Math.min(1.1, latestMeshState.alpha + deltaFactor);
        canBeStatic = this.meshStates.length === 1 && latestMeshState.alpha >= 1.1;
      }
    }
    const gl = this.gl;
    this.checkIfResize();
    if (!this.fbo) return canBeStatic;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const lerpFactor = Math.min(1, delta / 100);
    this.smoothedVolume += (this.volume - this.smoothedVolume) * lerpFactor;
    for (const state of this.meshStates) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.mainProgram.use();
      gl.activeTexture(gl.TEXTURE0);
      const uTime = tickTime / 1e4;
      this.mainProgram.setUniform1f("u_aspect", this.manualControl ? 1 : this.canvas.width / this.canvas.height);
      this.mainProgram.setUniform1i("u_texture", 0);
      this.mainProgram.setUniform1f("u_volume", this.volume);
      this.mainProgram.setUniform1f("u_alpha", 1);
      const angle = (uTime + this.volume) * 2;
      this.mainProgram.setUniform1f("u_sinAngle", Math.sin(angle));
      this.mainProgram.setUniform1f("u_cosAngle", Math.cos(angle));
      state.texture.bind();
      state.mesh.bind();
      state.mesh.draw();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.quadProgram.use();
      this.quadProgram.setUniform1i("u_texture", 0);
      this.quadProgram.setUniform1f("u_alpha", easeInOutSine(clamp01(state.alpha)));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      const a_pos = this.quadProgram.attrs.a_pos;
      gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(a_pos);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.disableVertexAttribArray(a_pos);
    }
    gl.flush();
    return canBeStatic;
  }
  onTickBinded = this.onTick.bind(this);
  requestTick() {
    if (this._disposed) return;
    if (this.tickHandle === 0) this.tickHandle = requestAnimationFrame(this.onTickBinded);
  }
  constructor(canvas) {
    super(canvas);
    const gl = canvas.getContext("webgl", { antialias: true });
    if (!gl) throw new Error("WebGL not supported");
    this.gl = gl;
    this.initializeGLResources();
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.requestTick();
  }
  onResize(width, height) {
    this.targetSize.x = Math.ceil(width);
    this.targetSize.y = Math.ceil(height);
    this.requestTick();
  }
  setStaticMode(enable) {
    this.staticMode = enable;
    this.lastFrameTime = performance.now();
    this.requestTick();
  }
  setFPS(fps) {
    this.maxFPS = fps;
  }
  pause() {
    if (this.tickHandle) {
      cancelAnimationFrame(this.tickHandle);
      this.tickHandle = 0;
    }
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.requestTick();
  }
  async setAlbum(albumSource, isVideo) {
    const requestId = ++this.albumRequestId;
    this.albumLoadController?.abort();
    const loadController = new AbortController();
    this.albumLoadController = loadController;
    if (albumSource === void 0 || typeof albumSource === "string" && albumSource.trim().length === 0) {
      this.isNoCover = true;
      this.lastImageData = void 0;
      return;
    }
    let res = null;
    let blob = null;
    let objectUrl;
    let remainRetryTimes = 5;
    while (!res && remainRetryTimes > 0) try {
      if (typeof albumSource === "string") {
        if (!isVideo && "createImageBitmap" in window) {
          blob = await (await fetch(albumSource, { signal: loadController.signal })).blob();
          if (!this.isCurrentAlbumRequest(requestId)) return;
          objectUrl = URL.createObjectURL(blob);
          res = await loadResourceFromUrl(objectUrl, false);
        } else res = await loadResourceFromUrl(albumSource, isVideo);
      } else res = await loadResourceFromElement(albumSource);
      if (!this.isCurrentAlbumRequest(requestId)) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }
    } catch (error) {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = void 0;
      }
      if (!this.isCurrentAlbumRequest(requestId)) return;
      console.warn(`failed on loading album resource, retrying (${remainRetryTimes})`, {
        albumSource,
        error
      });
      remainRetryTimes--;
    }
    if (!res) {
      if (!this.isCurrentAlbumRequest(requestId)) return;
      console.error("Failed to load album resource", albumSource);
      return;
    }
    const c = this.reduceImageSizeCanvas;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Failed to create canvas context");
    ctx.clearRect(0, 0, c.width, c.height);
    const imgw = res instanceof HTMLVideoElement ? res.videoWidth : res.naturalWidth;
    const imgh = res instanceof HTMLVideoElement ? res.videoHeight : res.naturalHeight;
    if (imgw * imgh === 0) throw new Error("Invalid image size");
    let bitmap = null;
    try {
      if ("createImageBitmap" in window) {
        if (blob) bitmap = await createImageBitmap(blob, {
          resizeWidth: c.width,
          resizeHeight: c.height,
          resizeQuality: "low"
        });
        else bitmap = await createImageBitmap(res, {
          resizeWidth: c.width,
          resizeHeight: c.height,
          resizeQuality: "low"
        });
      }
    } catch (e) {
      console.warn("createImageBitmap failed", e);
    }
    if (!this.isCurrentAlbumRequest(requestId)) {
      bitmap?.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      return;
    }
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    } else ctx.drawImage(res, 0, 0, imgw, imgh, 0, 0, c.width, c.height);
    const imageData = ctx.getImageData(0, 0, c.width, c.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      let r = pixels[i];
      let g = pixels[i + 1];
      let b = pixels[i + 2];
      r = (r - 128) * 0.4 + 128;
      g = (g - 128) * 0.4 + 128;
      b = (b - 128) * 0.4 + 128;
      const gray = r * 0.3 + g * 0.59 + b * 0.11;
      r = gray * -2 + r * 3;
      g = gray * -2 + g * 3;
      b = gray * -2 + b * 3;
      r = (r - 128) * 1.7 + 128;
      g = (g - 128) * 1.7 + 128;
      b = (b - 128) * 1.7 + 128;
      pixels[i] = r * 0.75;
      pixels[i + 1] = g * 0.75;
      pixels[i + 2] = b * 0.75;
    }
    blurImage(imageData, 2, 4);
    if (this.manualControl && this.meshStates.length > 0) {
      this.meshStates[0].texture.dispose();
      this.meshStates[0].texture = new GLTexture(this.gl, imageData);
    } else this.meshStates.push(this.createMeshState(imageData));
    this.isNoCover = false;
    this.lastImageData = imageData;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    this.requestTick();
  }
  setLowFreqVolume(volume) {
    this.volume = volume / 10;
  }
  setHasLyric(_hasLyric) {
  }
  dispose() {
    super.dispose();
    this.albumLoadController?.abort();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    if (this.tickHandle) {
      cancelAnimationFrame(this.tickHandle);
      this.tickHandle = 0;
    }
    this._disposed = true;
    this.mainProgram.dispose();
    this.quadProgram.dispose();
    this.gl.deleteBuffer(this.quadBuffer);
    if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
    if (this.fboTexture) this.gl.deleteTexture(this.fboTexture);
    for (const state of this.meshStates) {
      state.mesh.dispose();
      state.texture.dispose();
    }
  }
  enablePerformanceMonitor(enable) {
    this.enablePerformanceMonitoring = enable;
    if (enable) {
      this.frameCount = 0;
      this.lastFPSUpdate = performance.now();
    }
  }
  getCurrentFPS() {
    return this.currentFPS;
  }
  updatePerformanceStats(tickTime) {
    if (!this.enablePerformanceMonitoring) return;
    this.frameCount++;
    if (tickTime - this.lastFPSUpdate > 1e3) {
      this.currentFPS = this.frameCount;
      this.frameCount = 0;
      this.lastFPSUpdate = tickTime;
    }
  }
};
var TimedContainer = class extends Container {
  time = 0;
};
var PixiRenderer = class extends BaseRenderer {
  canvas;
  /**
  * 当前环境是否支持此渲染器
  */
  static isSupported() {
    return utils.isWebGLSupported();
  }
  app;
  curContainer;
  staticMode = false;
  lastContainer = /* @__PURE__ */ new Set();
  onTick = (delta) => {
    for (const lastContainer of this.lastContainer) {
      lastContainer.alpha = clampPositive(lastContainer.alpha - delta / 60);
      if (lastContainer.alpha <= 0) {
        this.app.stage.removeChild(lastContainer);
        this.lastContainer.delete(lastContainer);
        lastContainer.destroy(true);
      }
    }
    if (this.curContainer) {
      this.curContainer.alpha = Math.min(1, this.curContainer.alpha + delta / 60);
      const [s1, s2, s3, s4] = this.curContainer.children;
      const maxSize = Math.max(this.app.screen.width, this.app.screen.height);
      s1.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
      s2.position.set(this.app.screen.width / 2.5, this.app.screen.height / 2.5);
      s3.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
      s4.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
      s1.width = maxSize * Math.sqrt(2);
      s1.height = s1.width;
      s2.width = maxSize * 0.8;
      s2.height = s2.width;
      s3.width = maxSize * 0.5;
      s3.height = s3.width;
      s4.width = maxSize * 0.25;
      s4.height = s4.width;
      this.curContainer.time += delta * this.flowSpeed;
      s1.rotation += delta / 1e3 * this.flowSpeed;
      s2.rotation -= delta / 500 * this.flowSpeed;
      s3.rotation += delta / 1e3 * this.flowSpeed;
      s4.rotation -= delta / 750 * this.flowSpeed;
      s3.x = this.app.screen.width / 2 + this.app.screen.width / 4 * Math.cos(this.curContainer.time / 1e3 * 0.75);
      s3.y = this.app.screen.height / 2 + this.app.screen.width / 4 * Math.cos(this.curContainer.time / 1e3 * 0.75);
      s4.x = this.app.screen.width / 2 + this.app.screen.width / 4 * 0.1 + Math.cos(this.curContainer.time * 6e-3 * 0.75);
      s4.y = this.app.screen.height / 2 + this.app.screen.width / 4 * 0.1 + Math.cos(this.curContainer.time * 6e-3 * 0.75);
      if (this.curContainer.alpha >= 1 && this.lastContainer.size === 0 && this.staticMode) this.app.ticker.stop();
    }
  };
  constructor(canvas) {
    super(canvas);
    this.canvas = canvas;
    this.app = new Application({
      view: canvas,
      resizeTo: this.canvas,
      powerPreference: "low-power",
      backgroundAlpha: 1
    });
    this.rebuildFilters();
    this.app.ticker.maxFPS = 30;
    this.app.ticker.add(this.onTick);
    this.app.ticker.start();
  }
  onResize(width, height) {
    super.onResize(width, height);
    this.app.resize();
    this.rebuildFilters();
  }
  setRenderScale(scale) {
    super.setRenderScale(scale);
    this.rebuildFilters();
  }
  rebuildFilters() {
    const minBorder = Math.min(this.canvas.width, this.canvas.height);
    const maxBorder = Math.max(this.canvas.width, this.canvas.height);
    const c0 = new ColorMatrixFilter();
    c0.saturate(1.2, false);
    const c1 = new ColorMatrixFilter();
    c1.brightness(0.6, false);
    const c2 = new ColorMatrixFilter();
    c2.contrast(0.3, true);
    for (const filter of this.app.stage.filters ?? []) filter.destroy();
    this.app.stage.filters = [];
    this.app.stage.filters.push(new BlurFilter(5, 1));
    this.app.stage.filters.push(new BlurFilter(10, 1));
    this.app.stage.filters.push(new BlurFilter(20, 2));
    this.app.stage.filters.push(new BlurFilter(40, 2));
    this.app.stage.filters.push(new BlurFilter(80, 2));
    if (minBorder > 768) this.app.stage.filters.push(new BlurFilter(160, 4));
    if (minBorder > 1536) this.app.stage.filters.push(new BlurFilter(320, 4));
    this.app.stage.filters.push(c0, c1, c2);
    this.app.stage.filters.push(new BlurFilter(5, 1));
    if (Math.random() > 0.5) {
      this.app.stage.filters.push(new BulgePinchFilter({
        radius: (maxBorder + minBorder) / 2,
        strength: 1,
        center: [0.25, 1]
      }));
      this.app.stage.filters.push(new BulgePinchFilter({
        radius: (maxBorder + minBorder) / 2,
        strength: 1,
        center: [0.75, 0]
      }));
    } else {
      this.app.stage.filters.push(new BulgePinchFilter({
        radius: (maxBorder + minBorder) / 2,
        strength: 1,
        center: [0.75, 1]
      }));
      this.app.stage.filters.push(new BulgePinchFilter({
        radius: (maxBorder + minBorder) / 2,
        strength: 1,
        center: [0.25, 0]
      }));
    }
  }
  setStaticMode(enable = false) {
    this.staticMode = enable;
    this.app.ticker.start();
  }
  setFPS(fps) {
    this.app.ticker.maxFPS = fps;
  }
  pause() {
    this.app.ticker.stop();
    this.app.render();
  }
  resume() {
    this.app.ticker.start();
  }
  setLowFreqVolume(_volume) {
  }
  setHasLyric(_hasLyric) {
  }
  async setAlbum(albumSource, isVideo) {
    if (!albumSource || typeof albumSource === "string" && albumSource.trim().length === 0) return;
    let res = null;
    let remainRetryTimes = 5;
    let tex = null;
    while (!tex?.baseTexture?.resource?.valid && remainRetryTimes > 0) try {
      if (typeof albumSource === "string") res = await loadResourceFromUrl(albumSource, isVideo);
      else res = await loadResourceFromElement(albumSource);
      tex = Texture.from(res, { resourceOptions: { autoLoad: false } });
      await tex.baseTexture.resource.load();
    } catch (error) {
      console.warn(`failed on loading album image, retrying (${remainRetryTimes})`, albumSource, error);
      tex = null;
      remainRetryTimes--;
    }
    if (!tex) return;
    const container = new TimedContainer();
    const s1 = new Sprite(tex);
    const s2 = new Sprite(tex);
    const s3 = new Sprite(tex);
    const s4 = new Sprite(tex);
    s1.anchor.set(0.5, 0.5);
    s2.anchor.set(0.5, 0.5);
    s3.anchor.set(0.5, 0.5);
    s4.anchor.set(0.5, 0.5);
    s1.rotation = Math.random() * Math.PI * 2;
    s2.rotation = Math.random() * Math.PI * 2;
    s3.rotation = Math.random() * Math.PI * 2;
    s4.rotation = Math.random() * Math.PI * 2;
    container.addChild(s1, s2, s3, s4);
    if (this.curContainer) this.lastContainer.add(this.curContainer);
    this.curContainer = container;
    this.app.stage.addChild(container);
    this.curContainer.alpha = 0;
    this.app.ticker.start();
  }
  dispose() {
    super.dispose();
    this.app.ticker.remove(this.onTick);
    this.app.destroy(true);
  }
  getElement() {
    return this.canvas;
  }
};
var BackgroundRender = class BackgroundRender2 {
  element;
  renderer;
  constructor(renderer, canvas) {
    this.renderer = renderer;
    this.element = canvas;
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "-1";
    canvas.style.contain = "strict";
  }
  /**
  * 获取被包装的渲染器实例。
  *
  * 各个渲染器有自己特有的可调项（例如 {@link IsolationRenderer.setOptions}），
  * 这些项没法通过统一的 `AbstractBaseRenderer` 接口下发，需要拿到实例本体。
  */
  getRenderer() {
    return this.renderer;
  }
  static new(type) {
    const newCanvas = document.createElement("canvas");
    return new BackgroundRender2(new type(newCanvas), newCanvas);
  }
  setRenderScale(scale) {
    this.renderer.setRenderScale(scale);
  }
  setFlowSpeed(speed) {
    this.renderer.setFlowSpeed(speed);
  }
  setStaticMode(enable) {
    this.renderer.setStaticMode(enable);
  }
  setFPS(fps) {
    this.renderer.setFPS(fps);
  }
  pause() {
    this.renderer.pause();
  }
  resume() {
    this.renderer.resume();
  }
  setLowFreqVolume(volume) {
    this.renderer.setLowFreqVolume(volume);
  }
  setHasLyric(hasLyric) {
    this.renderer.setHasLyric(hasLyric);
  }
  setAlbum(albumSource, isVideo) {
    return this.renderer.setAlbum(albumSource, isVideo);
  }
  getElement() {
    return this.element;
  }
  dispose() {
    this.renderer.dispose();
    this.element.remove();
  }
};
var toD = (ms) => ms;
var toM = (ms) => ms;
var toNum = (t) => t;
var Duration = {
  ZERO: toD(0),
  fromMillis: (ms) => toD(ms),
  fromSecs: (s) => toD(s * 1e3),
  asMillis: (d) => toNum(d),
  asSecsF64: (d) => toNum(d) / 1e3,
  add: (a, b) => toD(toNum(a) + toNum(b)),
  sub: (a, b) => toD(toNum(a) - toNum(b)),
  saturatingSub: (a, b) => toD(Math.max(0, toNum(a) - toNum(b))),
  mulF64: (d, factor) => toD(toNum(d) * factor),
  divDuration: (a, b) => toNum(a) / toNum(b),
  min: (a, b) => a < b ? a : b,
  max: (a, b) => a > b ? a : b,
  clampPositive: (d) => toD(Math.max(0, toNum(d))),
  isZero: (d) => toNum(d) === 0,
  isFinite: (d) => Number.isFinite(toNum(d))
};
var MediaTime = {
  ZERO: toM(0),
  fromMillis: (ms) => toM(ms),
  asMillis: (t) => toNum(t),
  since: (a, b) => toD(toNum(a) - toNum(b)),
  saturatingSince: (a, b) => toD(Math.max(0, toNum(a) - toNum(b))),
  add: (t, d) => toM(toNum(t) + toNum(d)),
  sub: (t, d) => toM(toNum(t) - toNum(d)),
  min: (a, b) => a < b ? a : b,
  max: (a, b) => a > b ? a : b,
  cmp: (a, b) => toNum(a) - toNum(b),
  round: (t) => toM(Math.round(toNum(t)))
};
var MaskObsceneWordsMode = {
  /** 禁用任何不雅用语掩码 */
  Disabled: "",
  /** 完全掩码所有不雅用语 */
  FullMask: "full-mask",
  /** 保留首尾字符，屏蔽中间字符 */
  PartialMask: "partial-mask"
};
var LyricLineRenderMode = {
  SOLID: 0,
  GRADIENT: 1
};
var LayoutAlignAnchor = {
  Top: "top",
  Center: "center",
  Bottom: "bottom"
};
var LayoutReason = {
  /** 正常播放时间推进 */
  PlaybackTick: "playback-tick",
  /** 容器或窗口尺寸调整 */
  Resize: "resize",
  /** 用户交互挂起开始（触摸/滚轮触发） */
  InteractionStart: "interaction-start",
  /** 连续高频滚动（手指触摸滑动或松手后的 RAF 惯性滑动） */
  ContinuousScroll: "continuous-scroll",
  /** 离散单步滚动（鼠标滚轮单次滚动） */
  DiscreteScroll: "discrete-scroll",
  /** 跳转播放进度 */
  Seek: "seek",
  /** 重新构建歌词视图 */
  RebuildView: "rebuild-view",
  /** 视图结构或样式配置改变 */
  ConfigChange: "config-change"
};
var LayoutReasonStrategyMap = {
  [LayoutReason.PlaybackTick]: {
    disableStagger: false,
    resetInterlude: false,
    snapPosY: false
  },
  [LayoutReason.ContinuousScroll]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: true
  },
  [LayoutReason.DiscreteScroll]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: false
  },
  [LayoutReason.InteractionStart]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: false
  },
  [LayoutReason.Seek]: {
    disableStagger: true,
    resetInterlude: true,
    snapPosY: false
  },
  [LayoutReason.RebuildView]: {
    disableStagger: true,
    resetInterlude: true,
    snapPosY: false
  },
  [LayoutReason.Resize]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: false
  },
  [LayoutReason.ConfigChange]: {
    disableStagger: true,
    resetInterlude: false,
    snapPosY: false
  }
};
var MAX_FRAME_DELTA = Duration.fromMillis(100);
var lyric_player_module_default = {
  "active": "FmKaba_active",
  "bgWrapper": "FmKaba_bgWrapper",
  "bgWrapperActive": "FmKaba_bgWrapperActive",
  "bgWrapperHidden": "FmKaba_bgWrapperHidden",
  "bgWrapperTop": "FmKaba_bgWrapperTop",
  "bottomLine": "FmKaba_bottomLine",
  "bottomLineWrapper": "FmKaba_bottomLineWrapper",
  "disableSpring": "FmKaba_disableSpring",
  "emphasize": "FmKaba_emphasize",
  "emphasizeWrapper": "FmKaba_emphasizeWrapper",
  "gradientMask": "FmKaba_gradientMask",
  "hasDuetLine": "FmKaba_hasDuetLine",
  "interludeDots": "FmKaba_interludeDots",
  "isDuetWrapper": "FmKaba_isDuetWrapper",
  "lyricBgLine": "FmKaba_lyricBgLine",
  "lyricDuetLine": "FmKaba_lyricDuetLine",
  "lyricLine": "FmKaba_lyricLine",
  "lyricLineWrapper": "FmKaba_lyricLineWrapper",
  "lyricMainLine": "FmKaba_lyricMainLine",
  "lyricSubLine": "FmKaba_lyricSubLine",
  "playing": "FmKaba_playing",
  "romanWord": "FmKaba_romanWord",
  "rubyBaseWord": "FmKaba_rubyBaseWord",
  "rubyWord": "FmKaba_rubyWord",
  "tmpDisableTransition": "FmKaba_tmpDisableTransition",
  "wordBody": "FmKaba_wordBody",
  "wordWithRuby": "FmKaba_wordWithRuby"
};
var DEFAULT_OPTIMIZE_OPTIONS = {
  normalizeSpaces: true,
  resetLineTimestamps: true,
  syncMainAndBackgroundLines: true,
  cleanUnintentionalOverlaps: true,
  tryAdvanceStartTime: true
};
function normalizeSpaces(lines) {
  for (const line of lines) for (const word of line.words) word.word = word.word.replace(/\s+/g, " ");
}
function resetLineTimestamps(lines) {
  for (const line of lines) if (line.words.length === 1 && line.words[0].startTime === 0 && line.words[0].endTime === 0 && (line.startTime !== 0 || line.endTime !== 0)) {
    line.words[0].startTime = line.startTime;
    line.words[0].endTime = line.endTime;
  } else if (line.words.length > 0) {
    const firstWord = line.words[0];
    const lastWord = line.words[line.words.length - 1];
    line.startTime = firstWord.startTime;
    line.endTime = lastWord.endTime;
  }
}
function convertExcessiveBackgroundLines(lines) {
  let consecutiveBgCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.isBG) {
      consecutiveBgCount++;
      if (i === 0 || consecutiveBgCount > 1) line.isBG = false;
    } else consecutiveBgCount = 0;
  }
}
function syncMainAndBackgroundLines(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.isBG) continue;
    const nextLine = lines[i + 1];
    if (nextLine?.isBG) {
      const allWords = [...line.words, ...nextLine.words].filter((w) => w.word.trim().length > 0);
      const finalStart = Math.min(line.startTime, nextLine.startTime, ...allWords.map((w) => w.startTime));
      const finalEnd = Math.max(line.endTime, nextLine.endTime, ...allWords.map((w) => w.endTime));
      line.startTime = finalStart;
      line.endTime = finalEnd;
      nextLine.startTime = finalStart;
      nextLine.endTime = finalEnd;
    }
  }
}
function sortLyricLines(lines) {
  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    const mainLine = lines[i];
    const groupLines = [mainLine];
    if (!mainLine.isBG && lines[i + 1]?.isBG) groupLines.push(lines[++i]);
    groups.push({
      lines: groupLines,
      startTime: mainLine.startTime,
      originalIndex: groups.length
    });
  }
  groups.sort((a, b) => {
    return a.startTime - b.startTime || a.originalIndex - b.originalIndex;
  });
  let lineIndex = 0;
  for (const group of groups) for (const line of group.lines) lines[lineIndex++] = line;
}
function cleanUnintentionalOverlaps(lines, syncBackgroundLines) {
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (line.isBG) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine.isBG) continue;
      const overlap = line.endTime - nextLine.startTime;
      if (overlap <= 0) break;
      const percentageThreshold = (nextLine.endTime - nextLine.startTime) * 0.1;
      if (!(overlap >= 500 || overlap > 100 && overlap > percentageThreshold)) {
        line.endTime = nextLine.startTime;
        const attachedBgLine = lines[i + 1];
        if (syncBackgroundLines && attachedBgLine?.isBG) attachedBgLine.endTime = nextLine.startTime;
        break;
      }
    }
  }
}
function tryAdvanceStartTime(lines, syncBackgroundLines) {
  const defaultAdvanceAmount = 600;
  const fallbackAdvanceAmount = 400;
  const fallbackAdvanceRatio = 0.7;
  let prevLineStartTime = 0;
  let prevLineEndTime = 0;
  let prevMainGroupStartTime = 0;
  let prevMainGroupEndTime = 0;
  let hasPrevLine = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.isBG) continue;
    const originalStartTime = line.startTime;
    const originalEndTime = line.endTime;
    let targetAdvanceAmount = 0;
    let safeBoundary = 0;
    if (hasPrevLine) {
      if (originalStartTime >= prevLineEndTime) {
        targetAdvanceAmount = defaultAdvanceAmount;
        safeBoundary = prevMainGroupEndTime;
      } else {
        const overlapDuration = prevLineEndTime - originalStartTime;
        if (overlapDuration < fallbackAdvanceAmount) targetAdvanceAmount = overlapDuration * fallbackAdvanceRatio;
        else targetAdvanceAmount = fallbackAdvanceAmount;
        safeBoundary = prevLineStartTime;
      }
    } else {
      targetAdvanceAmount = defaultAdvanceAmount;
      safeBoundary = 0;
    }
    const targetTime = line.startTime - targetAdvanceAmount;
    const newStartTime = Math.max(safeBoundary, targetTime);
    if (newStartTime < line.startTime) line.startTime = newStartTime;
    const nextLine = lines[i + 1];
    if (syncBackgroundLines && nextLine?.isBG) nextLine.startTime = line.startTime;
    if (hasPrevLine) {
      if (originalStartTime < prevMainGroupEndTime && originalEndTime > prevMainGroupStartTime) {
        prevMainGroupStartTime = Math.min(prevMainGroupStartTime, originalStartTime);
        prevMainGroupEndTime = Math.max(prevMainGroupEndTime, originalEndTime);
      } else {
        prevMainGroupStartTime = originalStartTime;
        prevMainGroupEndTime = originalEndTime;
      }
    } else {
      prevMainGroupStartTime = originalStartTime;
      prevMainGroupEndTime = originalEndTime;
    }
    prevLineStartTime = line.startTime;
    prevLineEndTime = originalEndTime;
    hasPrevLine = true;
  }
}
function areOptimizeOptionsEqual(a = {}, b = {}) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) if (a[key] !== b[key]) return false;
  return true;
}
function optimizeLyricLines(lines, options) {
  const config = {
    ...DEFAULT_OPTIMIZE_OPTIONS,
    ...options
  };
  const syncBackgroundLines = config.syncMainAndBackgroundLines ?? true;
  if (config.normalizeSpaces) normalizeSpaces(lines);
  if (config.resetLineTimestamps) resetLineTimestamps(lines);
  convertExcessiveBackgroundLines(lines);
  if (syncBackgroundLines) syncMainAndBackgroundLines(lines);
  sortLyricLines(lines);
  if (config.cleanUnintentionalOverlaps) cleanUnintentionalOverlaps(lines, syncBackgroundLines);
  if (config.tryAdvanceStartTime) tryAdvanceStartTime(lines, syncBackgroundLines);
}
var FocusController = class {
  target = {
    type: "line",
    index: 0
  };
  /**
  * 推导本帧的对齐焦点，并将其记录为新的冻结目标
  * @param snapshot 当前帧的时间线快照
  * @param lineCount 当前歌词行总数
  * @param flags 播放器的交互状态
  */
  resolve(snapshot, lineCount, flags) {
    const nextTarget = flags.isAutoAlignSuspended ? this.resolveSuspendedTarget(snapshot, lineCount, flags) : this.resolveActiveTarget(snapshot, lineCount, flags);
    this.target = nextTarget;
    return nextTarget;
  }
  /**
  * 用户滚动挂起期间的焦点解析（维持上一帧目标或在间奏结束/不可用时顺延）
  */
  resolveSuspendedTarget(snapshot, lineCount, flags) {
    const target = this.target;
    switch (target.type) {
      case "line":
        return {
          type: "line",
          index: this.clampLineIndex(target.index, lineCount)
        };
      case "interlude":
        if (!(snapshot.isFocusOnInterlude && !!snapshot.activeInterlude && flags.canDisplayInterlude)) return {
          type: "line",
          index: this.clampLineIndex(target.anchorIndex + 1, lineCount)
        };
        return target;
      case "bottom":
        return target;
    }
  }
  /**
  * 正常播放状态下的自动焦点解析
  */
  resolveActiveTarget(snapshot, lineCount, flags) {
    if (snapshot.isFocusOnInterlude && snapshot.activeInterlude) {
      if (!flags.canDisplayInterlude) return {
        type: "line",
        index: this.clampLineIndex(snapshot.activeInterlude.anchorLineIndex + 1, lineCount)
      };
      return {
        type: "interlude",
        anchorIndex: snapshot.activeInterlude.anchorLineIndex
      };
    }
    if (snapshot.isEndOfSong) {
      if (flags.hasBottomContent) return { type: "bottom" };
      return {
        type: "line",
        index: this.clampLineIndex(lineCount - 1, lineCount)
      };
    }
    return {
      type: "line",
      index: this.clampLineIndex(snapshot.scrollToIndex, lineCount)
    };
  }
  /**
  * 将歌词行索引钳制到当前歌词范围内
  */
  clampLineIndex(index, lineCount) {
    if (lineCount <= 0) return 0;
    return Math.min(Math.max(0, index), lineCount - 1);
  }
  /**
  * 重置焦点至首行
  *
  * 一般在载入新歌词、重建歌词视图时调用
  */
  reset() {
    this.target = {
      type: "line",
      index: 0
    };
  }
};
var LayoutCalculator = class {
  /**
  * 前缀和缓存
  *
  * 长度为歌词行数 + 1
  *
  * prefixSums[i] 存储的是第 0 行到第 i-1 行的总高度，不包含间奏点
  */
  prefixSums = /* @__PURE__ */ new Float64Array(0);
  heights = /* @__PURE__ */ new Float64Array(0);
  /**
  * 使用 Uint8Array 作为掩码，1 表示该行经历了真实测量，0 表示该行在使用 fallback 高度
  */
  isMeasured = /* @__PURE__ */ new Uint8Array(0);
  /**
  * 渲染指令对象池
  *
  * 长度永远只会增加不会减少，避免 GC
  */
  instructionPool = [];
  isPrefixSumDirty = true;
  resolvedMetrics = {
    isValid: false,
    focalTopY: 0,
    anchorOffset: 0,
    interludeTotalHeight: 0,
    activeInterludeAnchor: void 0
  };
  /**
  * 全局唯一复用的返回结果实例
  */
  layoutResult = {
    lineCount: 0,
    lineInstructions: this.instructionPool,
    bottomLineY: 0,
    isBottomLineInViewport: false,
    hasInterlude: false,
    interludeY: 0
  };
  /**
  * 缓存的歌词行数
  */
  lyricCount = 0;
  /**
  * 缓存的所有歌词总高度
  */
  totalLyricHeight = 0;
  /**
  * 初始化排版空间结构与高度缓存
  *
  * 在加载新歌词时调用
  *
  * @param count 歌词总行数
  * @param defaultHeight 尚未渲染/测量的行的默认回退高度
  */
  initHeights(count, defaultHeight) {
    this.lyricCount = count;
    this.resetLayoutResult();
    if (this.prefixSums.length < count + 1) {
      this.prefixSums = new Float64Array(count + 1);
      this.heights = new Float64Array(count);
      this.isMeasured = new Uint8Array(count);
    } else this.prefixSums.fill(0);
    for (let i = 0; i < count; i++) {
      this.heights[i] = defaultHeight;
      this.isMeasured[i] = 0;
    }
    this.isPrefixSumDirty = true;
    const currentPoolSize = this.instructionPool.length;
    if (count > currentPoolSize) for (let i = currentPoolSize; i < count; i++) this.instructionPool.push({
      y: 0,
      height: 0,
      isInViewport: false
    });
  }
  /**
  * 获取指定索引歌词行的计算高度
  * @remarks 可能为测量值或估算值
  * @param index 歌词行索引
  */
  getLineHeight(index) {
    if (index < 0 || index >= this.lyricCount) return 0;
    this.ensurePrefixSums();
    return this.prefixSums[index + 1] - this.prefixSums[index];
  }
  /**
  * 设置单行歌词的真实测量高度
  * @param index 歌词行索引
  * @param height 真实测量的高度
  */
  setLineHeight(index, height) {
    if (index < 0 || index >= this.lyricCount) return;
    if (this.heights[index] !== height || this.isMeasured[index] === 0) {
      this.heights[index] = height;
      this.isMeasured[index] = 1;
      this.isPrefixSumDirty = true;
    }
  }
  /**
  * 批量更新所有未测量行的回退高度
  *
  * 仅在容器 Resize 等会导致回退基准（如 containerHeight / 5）发生变化时调用。
  * 已被真实测量的行不受影响。
  *
  * @param defaultHeight 新的默认回退高度
  */
  updateUnmeasuredHeights(defaultHeight) {
    let changed = false;
    for (let i = 0; i < this.lyricCount; i++) if (this.isMeasured[i] === 0 && this.heights[i] !== defaultHeight) {
      this.heights[i] = defaultHeight;
      changed = true;
    }
    if (changed) this.isPrefixSumDirty = true;
  }
  /**
  * 解析焦点度量并计算物理滚动边界
  *
  * 返回滚动安全闭区间 `{ min, max }` 以及此帧的生命周期会话句柄 {@link LayoutFrameSession}
  * 供后续使用 `ScrollInteractionEngine.updateBoundary` 钳制 `scrollOffset` 后传给 {@link commit}
  *
  * @param ctx 动态帧上下文，包含当前容器尺寸、焦点目标与底栏高度
  * @param config 布局静态配置，包含对齐锚点、相对位置与 Overscan 容差
  */
  beginFrame(ctx, config) {
    this.ensurePrefixSums();
    const metrics = this.resolveLayoutMetrics(ctx, config);
    const session = {
      ...metrics,
      containerHeight: ctx.containerHeight,
      alignPosition: config.alignPosition,
      overscanPx: config.overscanPx,
      bottomLineHeight: ctx.bottomLineHeight
    };
    if (!metrics.isValid) return {
      bounds: {
        min: 0,
        max: 0
      },
      session
    };
    const { focalTopY, anchorOffset, interludeTotalHeight, activeInterludeAnchor } = metrics;
    const minOffset = Math.min(0, -focalTopY);
    const basePosWithoutScroll = -focalTopY + ctx.containerHeight * config.alignPosition - anchorOffset;
    let totalContentHeight = this.totalLyricHeight;
    if (activeInterludeAnchor !== void 0) totalContentHeight += interludeTotalHeight;
    const rawMaxOffset = basePosWithoutScroll + totalContentHeight - ctx.containerHeight / 2;
    return {
      bounds: {
        min: minOffset,
        max: Math.max(0, rawMaxOffset)
      },
      session
    };
  }
  /**
  * 基于已钳制的 `scrollOffset` 和第一阶段的 {@link LayoutFrameSession} 提交排版并生成指令
  *
  * @param session 由 {@link beginFrame} 生成的单帧排版会话
  * @param scrollOffset 经过边界钳制后的安全滚动偏移量
  *
  * @returns 复用的排版结果实例 {@link LayoutResult}
  */
  commit(session, scrollOffset) {
    this.ensurePrefixSums();
    if (!session.isValid) return this.resetLayoutResult();
    this.layoutResult.lineCount = this.lyricCount;
    const { focalTopY, anchorOffset, interludeTotalHeight, activeInterludeAnchor, containerHeight, alignPosition, overscanPx, bottomLineHeight } = session;
    const viewportStartY = containerHeight * alignPosition - anchorOffset - scrollOffset - focalTopY;
    const motionBuffer = containerHeight * 0.4;
    const viewportTopBound = -overscanPx - motionBuffer;
    const viewportBottomBound = containerHeight + overscanPx + motionBuffer;
    for (let i = 0; i < this.lyricCount; i++) {
      const instruction = this.instructionPool[i];
      let lineY = viewportStartY + this.prefixSums[i];
      const lineH = this.prefixSums[i + 1] - this.prefixSums[i];
      if (activeInterludeAnchor !== void 0 && i > activeInterludeAnchor) lineY += interludeTotalHeight;
      instruction.y = lineY;
      instruction.height = lineH;
      instruction.isInViewport = lineY <= viewportBottomBound && lineY + lineH >= viewportTopBound;
    }
    if (activeInterludeAnchor !== void 0) {
      this.layoutResult.hasInterlude = true;
      this.layoutResult.interludeY = viewportStartY + this.prefixSums[activeInterludeAnchor + 1];
    } else {
      this.layoutResult.hasInterlude = false;
      this.layoutResult.interludeY = 0;
    }
    let bottomY = viewportStartY + this.totalLyricHeight;
    if (activeInterludeAnchor !== void 0) bottomY += interludeTotalHeight;
    this.layoutResult.bottomLineY = bottomY;
    this.layoutResult.isBottomLineInViewport = bottomY <= viewportBottomBound && bottomY + bottomLineHeight >= viewportTopBound;
    return this.layoutResult;
  }
  /**
  * 解析当前排版帧所对应的间奏点挂载锚点行索引
  *
  * @param interlude 当前时间线处于激活状态的间奏点信息
  * @param focalTarget 当前帧对齐的物理焦点
  */
  static resolveInterludeAnchorIndex(interlude, focalTarget) {
    if (interlude) return interlude.anchorLineIndex;
    if (focalTarget.type === "interlude") return focalTarget.anchorIndex;
  }
  /**
  * 如果高度发生过改变，则重新计算前缀和
  */
  ensurePrefixSums() {
    if (!this.isPrefixSumDirty) return;
    let sum = 0;
    this.prefixSums[0] = 0;
    for (let i = 0; i < this.lyricCount; i++) {
      sum += this.heights[i];
      this.prefixSums[i + 1] = sum;
    }
    this.totalLyricHeight = sum;
    this.isPrefixSumDirty = false;
  }
  /**
  * 公共的焦点度量与范围校验逻辑
  */
  resolveLayoutMetrics(ctx, config) {
    const interludeTotalHeight = ctx.interlude?.totalHeight ?? 0;
    const activeInterludeAnchor = ctx.interlude?.anchorIndex;
    this.resolvedMetrics.interludeTotalHeight = interludeTotalHeight;
    this.resolvedMetrics.activeInterludeAnchor = activeInterludeAnchor;
    if (this.lyricCount === 0 || ctx.target.type === "line" && (ctx.target.index < 0 || ctx.target.index >= this.lyricCount) || ctx.target.type === "interlude" && (ctx.target.anchorIndex < -1 || ctx.target.anchorIndex >= this.lyricCount - 1)) {
      this.resolvedMetrics.isValid = false;
      this.resolvedMetrics.focalTopY = 0;
      this.resolvedMetrics.anchorOffset = 0;
      return this.resolvedMetrics;
    }
    this.updateFocalMetrics(ctx.target, interludeTotalHeight, activeInterludeAnchor, ctx.bottomLineHeight, config);
    this.resolvedMetrics.isValid = true;
    return this.resolvedMetrics;
  }
  /**
  * 测量对齐目标的几何信息
  */
  updateFocalMetrics(target, interludeTotalHeight, activeInterludeAnchor, bottomLineHeight, config) {
    let focalTopY = 0;
    let targetHeight = 0;
    if (target.type === "line") {
      focalTopY = this.prefixSums[target.index];
      if (activeInterludeAnchor !== void 0 && target.index > activeInterludeAnchor) focalTopY += interludeTotalHeight;
      targetHeight = this.prefixSums[target.index + 1] - this.prefixSums[target.index];
    } else if (target.type === "interlude") {
      focalTopY = this.prefixSums[target.anchorIndex + 1];
      targetHeight = interludeTotalHeight;
    } else if (target.type === "bottom") {
      focalTopY = this.totalLyricHeight;
      if (activeInterludeAnchor !== void 0) focalTopY += interludeTotalHeight;
      targetHeight = bottomLineHeight;
    }
    this.resolvedMetrics.focalTopY = focalTopY;
    this.resolvedMetrics.anchorOffset = this.calculateAnchorOffset(config.alignAnchor, targetHeight);
  }
  /**
  * 根据锚点与目标高度计算内部相对偏移
  */
  calculateAnchorOffset(alignAnchor, targetHeight) {
    if (targetHeight <= 0) return 0;
    switch (alignAnchor) {
      case LayoutAlignAnchor.Top:
        return 0;
      case LayoutAlignAnchor.Center:
        return targetHeight / 2;
      case LayoutAlignAnchor.Bottom:
        return targetHeight;
    }
    return alignAnchor;
  }
  /**
  * 重置排版结果为安全干净的状态（全部不可见/无底栏）
  */
  resetLayoutResult() {
    this.layoutResult.lineCount = 0;
    this.layoutResult.hasInterlude = false;
    this.layoutResult.interludeY = 0;
    this.layoutResult.bottomLineY = 0;
    this.layoutResult.isBottomLineInViewport = false;
    for (let i = 0; i < this.instructionPool.length; i++) {
      this.instructionPool[i].isInViewport = false;
      this.instructionPool[i].y = 0;
      this.instructionPool[i].height = 0;
    }
    return this.layoutResult;
  }
};
function formatValue(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
function assertTimestamp(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`Invalid lyric timestamp at ${path}: ${formatValue(value)}`);
}
function assertTimestampRange(value, path) {
  const startTime = value.startTime;
  const endTime = value.endTime;
  assertTimestamp(startTime, `${path}.startTime`);
  assertTimestamp(endTime, `${path}.endTime`);
  if (startTime > endTime) throw new RangeError(`Invalid lyric timestamp range at ${path}: startTime ${startTime} is greater than endTime ${endTime}`);
}
function assertValidLyricTimestamps(lines) {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const linePath = `lines[${lineIndex}]`;
    assertTimestampRange(line, linePath);
    for (let wordIndex = 0; wordIndex < line.words.length; wordIndex++) {
      const word = line.words[wordIndex];
      const wordPath = `${linePath}.words[${wordIndex}]`;
      assertTimestampRange(word, wordPath);
      if (word.ruby) for (let rubyIndex = 0; rubyIndex < word.ruby.length; rubyIndex++) assertTimestampRange(word.ruby[rubyIndex], `${wordPath}.ruby[${rubyIndex}]`);
    }
  }
}
var LyricDataManager = class {
  /**
  * 原始的歌词行数组
  */
  rawLines = [];
  /**
  * 经过处理后的歌词行数组
  */
  processedLines = [];
  /**
  * 当前处理好的 processedLines 是否已经失效
  */
  isDirty = true;
  optimizeOpts = {};
  maskMode = MaskObsceneWordsMode.Disabled;
  maskChar = "*";
  isNonDynamic = false;
  hasDuetLine = false;
  setOriginalLines(lines) {
    assertValidLyricTimestamps(lines);
    this.rawLines = esm_default(lines);
    this.isDirty = true;
  }
  setConfig(config) {
    if (config.optimizeOptions) this.optimizeOpts = {
      ...this.optimizeOpts,
      ...config.optimizeOptions
    };
    this.maskMode = config.maskMode ?? this.maskMode;
    this.maskChar = config.maskChar?.charAt(0) ?? this.maskChar;
    this.isDirty = true;
  }
  /**
  * 获取用户设置的原始歌词行数组，未经过优化和掩码
  * @returns 原始歌词行数组
  */
  getRawLines() {
    return this.rawLines;
  }
  /**
  * 获取对原始歌词行数组处理过的的歌词行数组
  * @returns 经过处理的歌词行数组
  */
  getProcessedLines() {
    this.ensurePipeline();
    return this.processedLines;
  }
  /**
  * 歌词是否为非动态歌词，又称为逐行歌词
  */
  getIsNonDynamic() {
    this.ensurePipeline();
    return this.isNonDynamic;
  }
  /**
  * 歌词是否包含对唱歌词
  */
  getHasDuetLine() {
    this.ensurePipeline();
    return this.hasDuetLine;
  }
  getOptimizeOptions() {
    return this.optimizeOpts;
  }
  getMaskMode() {
    return this.maskMode;
  }
  getMaskChar() {
    return this.maskChar;
  }
  ensurePipeline() {
    if (!this.isDirty) return;
    this.processPipeline();
    this.isDirty = false;
  }
  processPipeline() {
    this.processedLines = esm_default(this.rawLines);
    optimizeLyricLines(this.processedLines, this.optimizeOpts);
    let checkNonDynamic = true;
    let checkDuet = false;
    for (const line of this.processedLines) {
      if (line.words.length > 1) checkNonDynamic = false;
      if (line.isDuet) checkDuet = true;
      for (const word of line.words) this.applyMask(word);
    }
    this.isNonDynamic = checkNonDynamic && this.processedLines.length > 0;
    this.hasDuetLine = checkDuet;
  }
  applyMask(word) {
    if (!word.obscene || this.maskMode === MaskObsceneWordsMode.Disabled) return;
    const text = word.word;
    const maskChar = this.maskChar;
    if (this.maskMode === MaskObsceneWordsMode.FullMask) word.word = text.replace(/\S/g, maskChar);
    else if (this.maskMode === MaskObsceneWordsMode.PartialMask) {
      const trimmed = text.trim();
      if (trimmed.length <= 2) word.word = text.replace(/\S/g, maskChar);
      else {
        const startPos = text.indexOf(trimmed);
        const endPos = startPos + trimmed.length - 1;
        word.word = text.slice(0, startPos + 1) + text.slice(startPos + 1, endPos).replace(/\S/g, maskChar) + text.slice(endPos);
      }
    }
  }
};
var AUTO_ALIGN_RESUME_DELAY_MS = 500;
var WHEEL_IDLE_TIMEOUT_MS = 150;
var BASE_FRAME_DURATION = Duration.fromMillis(1e3 / 60);
var MAX_INERTIA_FRAME_DELTA_MS = 100;
var ScrollInteractionEngine = class {
  container;
  hooks;
  offset = 0;
  minOffset = 0;
  maxOffset = 0;
  touchState = {
    startY: 0,
    startX: 0,
    lastY: 0,
    startOffset: 0,
    speed: 0,
    lastTimestamp: 0,
    /**
    * 是否已经突破 10px 意图阈值
    */
    isIntentConfirmed: false
  };
  /**
  * 记录 Touch 开始时被打断的既有状态
  */
  interruptedState = {
    hadInertia: false,
    hadTimer: false,
    wasInteracting: false
  };
  inertiaRafId = 0;
  scrollEndTime;
  isInteracting = false;
  wheelEndTimeoutId = 0;
  abortController = new AbortController();
  constructor(container, hooks) {
    this.container = container;
    this.hooks = hooks;
    const signal = this.abortController.signal;
    this.container.addEventListener("touchstart", this.onTouchStart, {
      passive: false,
      signal
    });
    this.container.addEventListener("touchmove", this.onTouchMove, {
      passive: false,
      signal
    });
    this.container.addEventListener("touchend", this.onTouchEnd, {
      passive: false,
      signal
    });
    this.container.addEventListener("touchcancel", this.onTouchCancel, {
      passive: false,
      signal
    });
    this.container.addEventListener("wheel", this.onWheel, {
      passive: false,
      signal
    });
  }
  startInteraction(type) {
    this.scrollEndTime = void 0;
    if (!this.isInteracting) {
      this.isInteracting = true;
      this.hooks.onInteractionStart(type);
    }
  }
  endInteraction() {
    this.isInteracting = false;
    this.clearTimers();
    this.scrollEndTime = performance.now();
  }
  onTouchStart = (evt) => {
    if (evt.touches.length > 1) {
      const touch2 = evt.touches[0];
      const state2 = this.touchState;
      state2.startY = touch2.screenY;
      state2.startX = touch2.screenX;
      state2.lastY = touch2.screenY;
      state2.startOffset = this.offset;
      state2.lastTimestamp = performance.now();
      state2.speed = 0;
      return;
    }
    this.interruptedState.hadInertia = this.inertiaRafId !== 0;
    this.interruptedState.hadTimer = this.wheelEndTimeoutId !== 0;
    this.interruptedState.wasInteracting = this.isInteracting;
    this.clearTimers();
    const touch = evt.touches[0];
    const state = this.touchState;
    state.startY = touch.screenY;
    state.startX = touch.screenX;
    state.lastY = touch.screenY;
    state.startOffset = this.offset;
    state.lastTimestamp = performance.now();
    state.speed = 0;
    state.isIntentConfirmed = false;
  };
  onTouchMove = (evt) => {
    const touch = evt.touches[0];
    const state = this.touchState;
    const deltaY = touch.screenY - state.startY;
    const deltaX = touch.screenX - state.startX;
    if (!state.isIntentConfirmed) {
      if (Math.abs(deltaY) > 10 || Math.abs(deltaX) > 10) {
        state.isIntentConfirmed = true;
        this.startInteraction("touch");
      } else return;
    }
    if (evt.cancelable) evt.preventDefault();
    const currentY = touch.screenY;
    this.offset = this.clampOffset(state.startOffset - (currentY - state.startY));
    const now = performance.now();
    const dt = Duration.fromMillis(now - state.lastTimestamp);
    const dtMs = Duration.asMillis(dt);
    if (dtMs > 0) state.speed = (currentY - state.lastY) / dtMs;
    state.lastY = currentY;
    state.lastTimestamp = now;
    this.hooks.onScrollUpdate(true);
  };
  onTouchCancel = (_evt) => {
    const state = this.touchState;
    if (!state.isIntentConfirmed) {
      const { hadInertia, hadTimer, wasInteracting } = this.interruptedState;
      if (hadInertia || hadTimer || wasInteracting) this.endInteraction();
      return;
    }
    state.speed = 0;
    state.startY = 0;
    this.endInteraction();
  };
  onTouchEnd = (evt) => {
    const state = this.touchState;
    if (evt.touches.length > 0) {
      const remainingTouch = evt.touches[0];
      state.startY = remainingTouch.screenY;
      state.startX = remainingTouch.screenX;
      state.lastY = remainingTouch.screenY;
      state.startOffset = this.offset;
      state.lastTimestamp = performance.now();
      state.speed = 0;
      return;
    }
    if (!state.isIntentConfirmed) {
      const { hadInertia, hadTimer, wasInteracting } = this.interruptedState;
      if (hadInertia || hadTimer || wasInteracting) this.endInteraction();
      return;
    }
    state.isIntentConfirmed = false;
    if (evt.cancelable) evt.preventDefault();
    state.startY = 0;
    if (this.inertiaRafId) {
      cancelAnimationFrame(this.inertiaRafId);
      this.inertiaRafId = 0;
    }
    if (Math.abs(state.speed) < 0.1) state.speed = 0;
    if (Math.abs(state.speed) > 0.05) {
      let lastFrameTime = performance.now();
      const onScrollFrame = (time) => {
        const dt = Duration.fromMillis(time - lastFrameTime);
        lastFrameTime = time;
        const dtMs = Duration.asMillis(dt);
        if (dtMs <= 0 || dtMs > MAX_INERTIA_FRAME_DELTA_MS) {
          this.inertiaRafId = requestAnimationFrame(onScrollFrame);
          return;
        }
        if (Math.abs(state.speed) > 0.05) {
          this.offset -= state.speed * dtMs;
          this.offset = this.clampOffset(this.offset);
          const steps = Duration.divDuration(dt, BASE_FRAME_DURATION);
          state.speed *= 0.95 ** steps;
          this.hooks.onScrollUpdate(true);
          this.inertiaRafId = requestAnimationFrame(onScrollFrame);
        } else {
          this.inertiaRafId = 0;
          this.endInteraction();
        }
      };
      this.inertiaRafId = requestAnimationFrame(onScrollFrame);
    } else this.endInteraction();
  };
  onWheel = (evt) => {
    this.clearTimers();
    this.startInteraction("wheel");
    if (evt.cancelable) evt.preventDefault();
    if (evt.deltaMode === WheelEvent.DOM_DELTA_PIXEL) this.offset += evt.deltaY;
    else this.offset += evt.deltaY * 50;
    this.offset = this.clampOffset(this.offset);
    this.hooks.onScrollUpdate(false);
    this.wheelEndTimeoutId = window.setTimeout(() => {
      this.wheelEndTimeoutId = 0;
      this.endInteraction();
    }, WHEEL_IDLE_TIMEOUT_MS);
  };
  /**
  * 将给定的偏移量限制在当前的 [minOffset, maxOffset] 边界内
  */
  clampOffset(val) {
    const min2 = Math.min(this.minOffset, this.maxOffset);
    const max2 = Math.max(this.minOffset, this.maxOffset);
    return Math.min(Math.max(val, min2), max2);
  }
  /**
  * 滚动结束是否已超过 {@link AUTO_ALIGN_RESUME_DELAY_MS}
  */
  get canResumeAutoAlign() {
    return this.scrollEndTime !== void 0 && performance.now() - this.scrollEndTime >= AUTO_ALIGN_RESUME_DELAY_MS;
  }
  /**
  * 更新允许的滚动边界，并返回钳制后的实际 offset
  *
  * @description
  * 在歌词发生排版变化，如页面 `resize`、加载了新歌词、展开背景歌词、歌词行高度改变时，
  * 计算出当前视口内允许滚动的上限与下限，通过此方法传给滚动引擎以确保滚动不会越界
  */
  updateBoundary(min2, max2) {
    this.minOffset = Math.min(0, min2);
    this.maxOffset = Math.max(0, max2);
    this.offset = this.clampOffset(this.offset);
    return this.offset;
  }
  /**
  * 覆盖当前的滚动偏移量并终止正在进行的惯性动画或等待状态
  *
  * @description
  * 当需要清空全部用户手势带来的临时滚动状态时，例如，用户点击了某行歌词触发了
  * Seek、歌曲切歌、或者焦点切换时恢复自动对齐，调用此方法重置滚动引擎
  */
  resetScroll(targetOffset = 0) {
    this.clearTimers();
    this.scrollEndTime = void 0;
    this.isInteracting = false;
    this.touchState.isIntentConfirmed = false;
    this.touchState.speed = 0;
    this.touchState.startY = 0;
    this.touchState.lastY = 0;
    this.touchState.lastTimestamp = 0;
    this.offset = this.clampOffset(targetOffset);
  }
  clearTimers() {
    if (this.inertiaRafId) {
      cancelAnimationFrame(this.inertiaRafId);
      this.inertiaRafId = 0;
    }
    if (this.wheelEndTimeoutId) {
      window.clearTimeout(this.wheelEndTimeoutId);
      this.wheelEndTimeoutId = 0;
    }
  }
  dispose() {
    this.abortController.abort();
    this.clearTimers();
    this.scrollEndTime = void 0;
  }
};
var JITTER_TOLERANCE = Duration.fromMillis(150);
var DRIFT_SLACK = 0.5;
var MAX_TRUSTED_GAP = Duration.fromMillis(800);
var SeekDetector = class {
  now;
  lastMediaTime = MediaTime.ZERO;
  lastWallTime = 0;
  hasBaseline = false;
  /**
  * @param now 物理时钟读取函数，默认为 `performance.now`
  */
  constructor(now = () => performance.now()) {
    this.now = now;
  }
  /**
  * 推导本次进度变化是否为跳转
  *
  * @param time 下游推送的当前播放进度
  * @param isPlaying 当前是否在播放，决定本次推送应有的推进量与容差
  * @returns 是否应当按跳转处理
  */
  detect(time, isPlaying) {
    const wall = this.now();
    if (!this.hasBaseline) {
      this.rebase(time, wall);
      this.hasBaseline = true;
      return false;
    }
    if (time < this.lastMediaTime) {
      this.rebase(time, wall);
      return true;
    }
    const mediaDelta = MediaTime.since(time, this.lastMediaTime);
    const elapsed = Duration.clampPositive(Duration.fromMillis(wall - this.lastWallTime));
    const wallDelta = Duration.min(elapsed, MAX_TRUSTED_GAP);
    this.rebase(time, wall);
    const expected = isPlaying ? wallDelta : Duration.ZERO;
    const tolerance = isPlaying ? Duration.max(JITTER_TOLERANCE, Duration.mulF64(wallDelta, DRIFT_SLACK)) : JITTER_TOLERANCE;
    return Duration.sub(mediaDelta, expected) > tolerance;
  }
  reset() {
    this.hasBaseline = false;
    this.lastMediaTime = MediaTime.ZERO;
    this.lastWallTime = 0;
  }
  rebase(time, wall) {
    this.lastMediaTime = time;
    this.lastWallTime = wall;
  }
};
var SLOW_STIFFNESS = 90;
var SLOW_DAMPING = 15;
var MEDIUM_STIFFNESS = 140;
var MEDIUM_DAMPING = 22;
var MIN_INTERVAL = 100;
var MAX_INTERVAL = 800;
var MIN_STIFFNESS = 170;
var DAMPING_MULTIPLIER = 2.2;
var INTERVAL_EXPONENT = 0.2;
function getPosYSpringPolicy(isSeeking, isInterludeActive, intervalMs, isEndOfSong = false) {
  if (isSeeking || isInterludeActive) return {
    stiffness: SLOW_STIFFNESS,
    damping: SLOW_DAMPING
  };
  if (isEndOfSong) return {
    stiffness: MEDIUM_STIFFNESS,
    damping: MEDIUM_DAMPING
  };
  if (intervalMs == null) return {
    stiffness: SLOW_STIFFNESS,
    damping: SLOW_DAMPING
  };
  let ratio = 1 - (Math.min(Math.max(intervalMs, MIN_INTERVAL), MAX_INTERVAL) - MIN_INTERVAL) / 700;
  ratio = ratio ** INTERVAL_EXPONENT;
  const targetStiffness = MIN_STIFFNESS + ratio * 50;
  return {
    stiffness: targetStiffness,
    damping: Math.sqrt(targetStiffness) * DAMPING_MULTIPLIER
  };
}
var MIN_INTERLUDE_GAP = Duration.fromMillis(7e3);
var TimelineController = class {
  lyricBounds = [];
  /**
  * 全部歌词行中最晚的结束时间，用于判定歌曲是否播放完毕
  */
  maxEndTime = MediaTime.ZERO;
  /**
  * 预先计算的间奏区域
  */
  precalculatedInterludes = [];
  /**
  * 保存上次顺序扫描停止的位置，用于避免每次都从头遍历所有歌词，提高性能
  */
  playbackCursor = 0;
  interludeCursor = 0;
  playingGroupsSet = /* @__PURE__ */ new Set();
  highlightedGroupsSet = /* @__PURE__ */ new Set();
  nextPlayingSet = /* @__PURE__ */ new Set();
  nextHighlightedSet = /* @__PURE__ */ new Set();
  addedPlayingIds = [];
  removedPlayingIds = [];
  addedHighlightedIds = [];
  removedHighlightedIds = [];
  expiredHighlightedIds = [];
  snapshot = {
    currentTime: MediaTime.ZERO,
    playingGroups: this.playingGroupsSet,
    highlightedGroups: this.highlightedGroupsSet,
    scrollToIndex: 0,
    latestHighlightedIndex: void 0,
    isEndOfSong: false,
    activeInterlude: void 0,
    isFocusOnInterlude: false
  };
  diff = {
    hasChanged: false,
    isTimeJumped: false,
    addedPlaying: this.addedPlayingIds,
    removedPlaying: this.removedPlayingIds,
    addedHighlighted: this.addedHighlightedIds,
    removedHighlighted: this.removedHighlightedIds,
    isInterludeChanged: false,
    isScrollToChanged: false,
    isEndOfSongChanged: false
  };
  /**
  * 提前设置好歌词的时间数据，内部会根据此数据来进行时间线推导，同时预计算间奏区间
  *
  * @param bounds 歌词行的时间边界，**必须按 `startTime` 升序排列**，不按 `startTime`
  * 排列可能会导致时间推导出现意外情况
  */
  setTimeBounds(bounds) {
    this.lyricBounds = bounds;
    this.precalculatedInterludes = this.calculateInterludes(bounds);
    let maxEnd = MediaTime.ZERO;
    for (const bound of bounds) maxEnd = MediaTime.max(maxEnd, bound.endTime);
    this.maxEndTime = maxEnd;
    this.reset();
  }
  /**
  * 获取当前播放时间线状态的只读快照
  *
  * 用于给 UI 执行排版和计算各种歌词行的效果
  *
  * @remarks 在获取快照后，必须在同一帧内消费完毕，切勿保留其引用，因为下一帧就会被原地覆写
  * @returns 时间线快照
  */
  getSnapshot() {
    return this.snapshot;
  }
  /**
  * 将播放进度推进到指定时间，并返回相对上一帧的增量变化
  *
  * @remarks
  * 歌词行的高亮生命周期为：
  * * 命中 `[startTime, endTime)` 时高亮
  * * 唱完后不会自行熄灭，而是继续保持高亮
  *
  * 直到出现下列任一情况：
  *
  * 1. 有新的歌词行开始播放，此时已唱完的行被一起熄灭
  * 2. 进入间奏区间，此时清空全部高亮并把焦点交给间奏点
  * 3. 歌曲播放完毕，此时清空全部高亮并设置 {@link TimelineSnapshot.isEndOfSong} 为 true
  * 4. 发生跳转，此时按跳转后的时间重新推导
  *
  * @param time 当前播放时间
  * @param forceSeek 这次时间变化是否由跳转触发
  * @returns 相对上一帧的增量变化
  */
  sync(time, forceSeek = false) {
    this.addedPlayingIds.length = 0;
    this.removedPlayingIds.length = 0;
    this.addedHighlightedIds.length = 0;
    this.removedHighlightedIds.length = 0;
    const prevInterlude = this.snapshot.activeInterlude;
    const prevFocusOnInterlude = this.snapshot.isFocusOnInterlude;
    const prevScrollToIndex = this.snapshot.scrollToIndex;
    const prevEndOfSong = this.snapshot.isEndOfSong;
    const isTimeRetreating = time < this.snapshot.currentTime;
    const isJump = forceSeek || isTimeRetreating;
    const activeInterlude = this.resolveActiveInterlude(time, isJump);
    this.snapshot.activeInterlude = activeInterlude;
    const isPastLastLine = this.lyricBounds.length > 0 && time >= this.maxEndTime;
    if (isJump) this.performSeek(time, !!activeInterlude || isPastLastLine);
    else this.performPlayback(time);
    if (activeInterlude && this.playingGroupsSet.size === 0) this.flushAllHighlighted();
    if (isPastLastLine) this.flushAllHighlighted();
    this.updateInterludeFocus(activeInterlude);
    const isInterludeChanged = prevInterlude !== activeInterlude;
    const isFocusChanged = prevFocusOnInterlude !== this.snapshot.isFocusOnInterlude;
    const isScrollToChanged = prevScrollToIndex !== this.snapshot.scrollToIndex;
    const isEndOfSongChanged = isPastLastLine !== prevEndOfSong;
    const hasChanged = isJump || this.addedPlayingIds.length > 0 || this.removedPlayingIds.length > 0 || this.addedHighlightedIds.length > 0 || this.removedHighlightedIds.length > 0 || isInterludeChanged || isFocusChanged || isScrollToChanged || isEndOfSongChanged;
    this.snapshot.currentTime = time;
    if (this.highlightedGroupsSet.size > 0) {
      let maxIndex = -1;
      for (const id of this.highlightedGroupsSet) if (id > maxIndex) maxIndex = id;
      this.snapshot.latestHighlightedIndex = maxIndex;
    } else this.snapshot.latestHighlightedIndex = void 0;
    this.snapshot.isEndOfSong = isPastLastLine;
    this.diff.hasChanged = hasChanged;
    this.diff.isTimeJumped = isJump;
    this.diff.isInterludeChanged = isInterludeChanged;
    this.diff.isScrollToChanged = isScrollToChanged;
    this.diff.isEndOfSongChanged = isEndOfSongChanged;
    return this.diff;
  }
  /**
  * 处理正常播放时的时间线推导
  */
  performPlayback(time) {
    for (const lastPlayingId of this.playingGroupsSet) {
      const bound = this.lyricBounds[lastPlayingId];
      if (!bound || time < bound.startTime || bound.endTime <= time) {
        this.playingGroupsSet.delete(lastPlayingId);
        this.removedPlayingIds.push(lastPlayingId);
      }
    }
    let cursor = Math.max(0, this.playbackCursor);
    const len = this.lyricBounds.length;
    while (cursor < len) {
      const bound = this.lyricBounds[cursor];
      if (bound.startTime > time) break;
      if (bound.startTime <= time && bound.endTime > time && !this.playingGroupsSet.has(cursor)) {
        this.playingGroupsSet.add(cursor);
        this.addedPlayingIds.push(cursor);
      }
      cursor++;
    }
    this.playbackCursor = cursor;
    this.expiredHighlightedIds.length = 0;
    for (const id of this.highlightedGroupsSet) if (!this.playingGroupsSet.has(id)) this.expiredHighlightedIds.push(id);
    const addedPlayingCount = this.addedPlayingIds.length;
    const expiredCount = this.expiredHighlightedIds.length;
    for (let i = 0; i < addedPlayingCount; i++) {
      const id = this.addedPlayingIds[i];
      this.highlightedGroupsSet.add(id);
      this.addedHighlightedIds.push(id);
    }
    if (addedPlayingCount > 0) {
      for (let i = 0; i < expiredCount; i++) {
        const id = this.expiredHighlightedIds[i];
        this.highlightedGroupsSet.delete(id);
        this.removedHighlightedIds.push(id);
      }
      let minHighlighted = Number.POSITIVE_INFINITY;
      for (const id of this.highlightedGroupsSet) if (id < minHighlighted) minHighlighted = id;
      this.snapshot.scrollToIndex = minHighlighted;
    }
  }
  /**
  * 处理 Seek 时的时间线推导
  *
  * 直接按目标时间重建播放与高亮行集合，结果与正常播放到该时刻时一致
  *
  * @param time 跳转到的时间
  * @param dropLingeringWhenIdle 在没有任何行正在播放时，是否丢弃那些已经唱完、
  * 但在正常播放中仍会保持高亮的行，用于在间奏和播放完时清空高亮行
  */
  performSeek(time, dropLingeringWhenIdle) {
    const nextPlaying = this.nextPlayingSet;
    const nextHighlighted = this.nextHighlightedSet;
    nextPlaying.clear();
    nextHighlighted.clear();
    let left = 0;
    let right = this.lyricBounds.length - 1;
    let firstGreater = this.lyricBounds.length;
    while (left <= right) {
      const mid = left + right >> 1;
      if (this.lyricBounds[mid].startTime > time) {
        firstGreater = mid;
        right = mid - 1;
      } else left = mid + 1;
    }
    let anchorIndex = -1;
    for (let i = firstGreater - 1; i >= 0; i--) {
      const bound = this.lyricBounds[i];
      if (bound.endTime > bound.startTime) {
        anchorIndex = i;
        break;
      }
    }
    if (anchorIndex === -1) {
      this.playbackCursor = firstGreater;
      this.snapshot.scrollToIndex = 0;
      this.commitSeekDiff();
      return;
    }
    const anchorStart = this.lyricBounds[anchorIndex].startTime;
    let minPlaying = -1;
    let minHighlighted = -1;
    for (let i = anchorIndex; i >= 0; i--) {
      const bound = this.lyricBounds[i];
      if (bound.endTime <= anchorStart) continue;
      if (bound.startTime <= time && bound.endTime > time) {
        nextPlaying.add(i);
        minPlaying = i;
      }
      nextHighlighted.add(i);
      minHighlighted = i;
    }
    if (dropLingeringWhenIdle && nextPlaying.size === 0) nextHighlighted.clear();
    this.playbackCursor = minPlaying === -1 ? firstGreater : minPlaying;
    this.snapshot.scrollToIndex = minHighlighted;
    this.commitSeekDiff();
  }
  /**
  * 把 Seek 重建出的目标集合与上一帧的集合求对称差，输出发生变化的部分
  */
  commitSeekDiff() {
    for (const id of this.playingGroupsSet) if (!this.nextPlayingSet.has(id)) {
      this.playingGroupsSet.delete(id);
      this.removedPlayingIds.push(id);
    }
    for (const id of this.nextPlayingSet) if (!this.playingGroupsSet.has(id)) {
      this.playingGroupsSet.add(id);
      this.addedPlayingIds.push(id);
    }
    for (const id of this.highlightedGroupsSet) if (!this.nextHighlightedSet.has(id)) {
      this.highlightedGroupsSet.delete(id);
      this.removedHighlightedIds.push(id);
    }
    for (const id of this.nextHighlightedSet) if (!this.highlightedGroupsSet.has(id)) {
      this.highlightedGroupsSet.add(id);
      this.addedHighlightedIds.push(id);
    }
  }
  /**
  * 立即熄灭当前全部高亮歌词行
  *
  * 用于间奏与曲末这两个没有下一行接续、但必须清空高亮的场景
  */
  flushAllHighlighted() {
    if (this.highlightedGroupsSet.size === 0) return;
    for (const id of this.highlightedGroupsSet) this.removedHighlightedIds.push(id);
    this.highlightedGroupsSet.clear();
  }
  /**
  * 预计算全部间奏区间
  * @param bounds 按 `startTime` 升序排列的歌词时间边界
  * @returns 按时间升序排列、互不重叠的间奏区间，供二分查找与游标推进使用
  */
  calculateInterludes(bounds) {
    const interludes = [];
    let maxEnd = MediaTime.ZERO;
    for (let i = -1; i < bounds.length - 1; i++) {
      if (i >= 0) maxEnd = MediaTime.max(maxEnd, bounds[i].endTime);
      const gapEnd = MediaTime.max(maxEnd, bounds[i + 1].startTime);
      if (MediaTime.since(gapEnd, maxEnd) >= MIN_INTERLUDE_GAP) interludes.push({
        startTime: maxEnd,
        endTime: gapEnd,
        anchorLineIndex: i
      });
    }
    return interludes;
  }
  /**
  * 查找当前时间命中的间奏区间，并顺带推进或重定位间奏游标
  * @param time 当前播放时间
  * @param isSeek 当前帧是否为跳转
  * @returns 命中的间奏区间，未命中时为 undefined
  */
  resolveActiveInterlude(time, isSeek) {
    if (this.precalculatedInterludes.length === 0) return void 0;
    if (isSeek) {
      let cursor = this.precalculatedInterludes.length;
      let left = 0;
      let right = this.precalculatedInterludes.length - 1;
      while (left <= right) {
        const mid = left + right >> 1;
        if (this.precalculatedInterludes[mid].endTime > time) {
          cursor = mid;
          right = mid - 1;
        } else left = mid + 1;
      }
      this.interludeCursor = cursor;
      if (cursor < this.precalculatedInterludes.length) {
        const inter = this.precalculatedInterludes[cursor];
        if (time >= inter.startTime && time < inter.endTime) return inter;
      }
      return;
    }
    while (this.interludeCursor < this.precalculatedInterludes.length) {
      const inter = this.precalculatedInterludes[this.interludeCursor];
      if (time >= inter.startTime && time < inter.endTime) return inter;
      if (time >= inter.endTime) this.interludeCursor++;
      else break;
    }
  }
  /**
  * 根据间奏命中情况和当前高亮状态推导是否应当聚焦间奏点
  *
  * 处于间奏区域且没有任何歌词高亮时聚焦间奏点，否则交还给歌词行
  *
  * @param activeInterlude 当前命中的间奏区间
  */
  updateInterludeFocus(activeInterlude) {
    this.snapshot.isFocusOnInterlude = !!activeInterlude && this.highlightedGroupsSet.size === 0;
  }
  /**
  * 清空全部推导状态，回到时间原点
  */
  reset() {
    this.playbackCursor = 0;
    this.interludeCursor = 0;
    this.playingGroupsSet.clear();
    this.highlightedGroupsSet.clear();
    this.nextPlayingSet.clear();
    this.nextHighlightedSet.clear();
    this.snapshot.currentTime = MediaTime.ZERO;
    this.snapshot.scrollToIndex = 0;
    this.snapshot.latestHighlightedIndex = void 0;
    this.snapshot.isEndOfSong = false;
    this.snapshot.activeInterlude = void 0;
    this.snapshot.isFocusOnInterlude = false;
  }
};
function getEntrySize(entry) {
  if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
    const borderBox = entry.borderBoxSize[0];
    return [borderBox.inlineSize, borderBox.blockSize];
  }
  const el = entry.target;
  return [el.offsetWidth || entry.contentRect.width, el.offsetHeight || entry.contentRect.height];
}
var LyricPlayerBase = class extends EventTarget {
  element = document.createElement("div");
  isPlaying = false;
  timelineController = new TimelineController();
  seekDetector = new SeekDetector();
  enableAutoSeekDetection = true;
  hasBottomContent = false;
  bottomLineObserver;
  /** @internal */
  lyricGroupElementMap = /* @__PURE__ */ new WeakMap();
  lyricLinesIndexes = /* @__PURE__ */ new WeakMap();
  disableSpring = false;
  dataManager = new LyricDataManager();
  get processedLines() {
    return this.dataManager.getProcessedLines();
  }
  get isNonDynamic() {
    return this.dataManager.getIsNonDynamic();
  }
  get hasDuetLine() {
    return this.dataManager.getHasDuetLine();
  }
  layoutState = { interludeDotsSize: [0, 0] };
  layoutConfig = {
    alignAnchor: LayoutAlignAnchor.Center,
    alignPosition: 0.35,
    overscanPx: 300
  };
  /** LayoutCalculator 所使用的排版上下文状态 */
  frameContext = {
    containerHeight: 0,
    scrollOffset: 0,
    target: {
      index: 0,
      type: "line"
    },
    bottomLineHeight: 0,
    interlude: void 0
  };
  /**
  * 逐帧刷新的视觉推导派生值
  *
  * 存放会在逐行循环内被反复求值的量，避免逐行重算
  */
  visualFrame = {
    /** 最靠后的高亮行，无高亮时回退到 `scrollToIndex` */
    latestIndex: 0,
    /** 已播放行的分界，`hidePassedLines` 启用时此行之前的歌词被隐藏 */
    passedBoundary: 0,
    /** 是否为窄视口，窄视口下模糊强度打折 */
    isNarrowViewport: false
  };
  interludeDots;
  bottomLine;
  enableBlur = true;
  enableScale = true;
  hidePassedLines = false;
  scrollEngine;
  scrollState = {
    isAutoAlignSuspended: false,
    isTouchScrolled: false
  };
  layoutCalculator = new LayoutCalculator();
  focusController = new FocusController();
  currentLyricGroups = [];
  lyricGroupSize = /* @__PURE__ */ new WeakMap();
  size = [0, 0];
  isPageVisible = true;
  /** 默认/回退单行歌词估算高度基准 (containerHeight / 5) */
  get defaultLineHeight() {
    return this.size[1] / 5;
  }
  /**
  * 获取指定索引歌词行的高度
  * @remarks 可能为测量值或估算值
  */
  getLineHeight(index) {
    return this.layoutCalculator.getLineHeight(index);
  }
  /** 是否强制让背景人声行始终后置（即始终在主歌词下方显示，不前置背景人声） */
  alwaysPostpositionBackground = false;
  posXSpringParams = {
    mass: 1,
    damping: 10,
    stiffness: 100
  };
  posYSpringParams = {
    mass: 0.9,
    damping: 15,
    stiffness: 90
  };
  scaleSpringParams = {
    mass: 2,
    damping: 25,
    stiffness: 100
  };
  scaleForBGSpringParams = {
    mass: 1,
    damping: 20,
    stiffness: 50
  };
  lyricGroupIndexMap = /* @__PURE__ */ new WeakMap();
  onPageShow = () => {
    this.isPageVisible = true;
    this.setCurrentTime(this.getCurrentTime(), true);
  };
  onPageHide = () => {
    this.isPageVisible = false;
  };
  onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    this.seekDetector.reset();
  };
  /** @internal */
  resizeObserver = new ResizeObserver(((entries) => {
    let shouldRelayout = false;
    let shouldRebuildPlayerStyle = false;
    let shouldUpdateFallback = false;
    for (const entry of entries) if (entry.target === this.element) {
      const rect = entry.contentRect;
      this.size[0] = rect.width;
      this.size[1] = rect.height;
      shouldRebuildPlayerStyle = true;
      shouldUpdateFallback = true;
    } else if (entry.target === this.interludeDots.getElement()) {
      const size = getEntrySize(entry);
      this.layoutState.interludeDotsSize[0] = size[0];
      this.layoutState.interludeDotsSize[1] = size[1];
      shouldRelayout = true;
    } else if (entry.target === this.bottomLine.getElement()) {
      const newSize = getEntrySize(entry);
      const oldSize = this.bottomLine.lineSize;
      if (newSize[0] !== oldSize[0] || newSize[1] !== oldSize[1]) {
        this.bottomLine.lineSize = newSize;
        shouldRelayout = true;
      }
    } else {
      const groupObj = this.lyricGroupElementMap.get(entry.target);
      if (groupObj) {
        const newSize = getEntrySize(entry);
        if (entry.target === groupObj.getElement()) {
          const oldSize = this.lyricGroupSize.get(groupObj) ?? [0, 0];
          if (newSize[0] !== oldSize[0] || newSize[1] !== oldSize[1]) {
            this.lyricGroupSize.set(groupObj, newSize);
            groupObj.onLineSizeChange(newSize);
            const index = this.lyricGroupIndexMap.get(groupObj) ?? -1;
            if (index !== -1) this.layoutCalculator.setLineHeight(index, newSize[1]);
            shouldRelayout = true;
          }
        } else groupObj.onBgSizeChange?.(newSize);
      }
    }
    if (shouldUpdateFallback) {
      this.layoutCalculator.updateUnmeasuredHeights(this.defaultLineHeight);
      shouldRelayout = true;
    }
    if (shouldRelayout) this.calcLayout(LayoutReason.Resize);
    if (shouldRebuildPlayerStyle) this.onResize();
  }));
  wordFadeWidth = 0.5;
  constructor(element) {
    super();
    if (element) this.element = element;
    this.element.classList.add("amll-lyric-player");
    this.interludeDots = this.createInterludeDots();
    this.bottomLine = this.createBottomLine();
    this.resizeObserver.observe(this.element);
    this.resizeObserver.observe(this.interludeDots.getElement());
    this.resizeObserver.observe(this.bottomLine.getElement());
    this.element.appendChild(this.interludeDots.getElement());
    this.element.appendChild(this.bottomLine.getElement());
    this.interludeDots.setTransform(0, 200);
    this.bottomLineObserver = new MutationObserver(() => {
      const newHasBottomContent = this.getBottomLineElement().innerHTML.trim().length > 0;
      if (this.hasBottomContent !== newHasBottomContent) {
        if (newHasBottomContent) this.bottomLine.resetPosition();
        this.hasBottomContent = newHasBottomContent;
        this.calcLayout(LayoutReason.ConfigChange);
      }
    });
    this.bottomLineObserver.observe(this.getBottomLineElement(), {
      childList: true,
      characterData: true,
      subtree: true
    });
    window.addEventListener("pageshow", this.onPageShow);
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.scrollEngine = new ScrollInteractionEngine(this.element, {
      onScrollUpdate: (isContinuous) => {
        this.calcLayout(isContinuous ? LayoutReason.ContinuousScroll : LayoutReason.DiscreteScroll);
      },
      onInteractionStart: (type) => {
        this.scrollState.isAutoAlignSuspended = true;
        this.scrollState.isTouchScrolled = type === "touch";
        this.calcLayout(LayoutReason.InteractionStart);
      }
    });
  }
  /**
  * 设置文字动画的渐变宽度，单位以歌词行的主文字字体大小的倍数为单位，默认为 0.5，即一个全角字符的一半宽度
  *
  * 如果要模拟 Apple Music for Android 的效果，可以设置为 1
  *
  * 如果要模拟 Apple Music for iPad 的效果，可以设置为 0.5
  *
  * 如果想要近乎禁用渐变效果，可以设置成非常接近 0 的小数（例如 `0.0001` ），但是**不可以为 0**
  *
  * @param value 需要设置的渐变宽度，单位以歌词行的主文字字体大小的倍数为单位，默认为 0.5
  */
  setWordFadeWidth(value = 0.5) {
    this.wordFadeWidth = Math.max(1e-4, value);
  }
  /**
  * 是否启用歌词行缩放效果，默认启用
  *
  * 如果启用，非选中的歌词行会轻微缩小以凸显当前播放歌词行效果
  *
  * 此效果对性能影响微乎其微，推荐启用
  * @param enable 是否启用歌词行缩放效果
  */
  setEnableScale(enable = true) {
    this.enableScale = enable;
    this.calcLayout(LayoutReason.ConfigChange);
  }
  /**
  * 获取当前是否启用了歌词行缩放效果
  * @returns 是否启用歌词行缩放效果
  */
  getEnableScale() {
    return this.enableScale;
  }
  /**
  * 获取当前文字动画的渐变宽度，单位以歌词行的主文字字体大小的倍数为单位
  * @returns 当前文字动画的渐变宽度，单位以歌词行的主文字字体大小的倍数为单位
  */
  getWordFadeWidth() {
    return this.wordFadeWidth;
  }
  /**
  * 设置持续性的跳转状态
  *
  * @deprecated 此方法已无实际作用，调用它不会产生任何效果，仅为兼容保留，将在未来移除
  *
  * 跳转状态现在由每次进度推送逐帧推导，不再存在需要外部显式解除的持续状态
  *
  * 跳转会通过以下三条途径被识别，三者同时生效：
  *
  * - {@link setCurrentTime} 的 `isSeek` 参数，由调用方明确告知某次进度变化是跳转
  * - 进度倒退，由内部无条件识别，不受任何开关控制
  * - 自动推导，由内部比对进度的实际推进量与它应有的推进量识别超量前进，默认启用，
  *   可通过 {@link setEnableAutoSeekDetection} 关闭
  */
  setIsSeeking(_isSeeking) {
  }
  /**
  * 设置是否自动推导跳转状态，默认启用
  *
  * 启用后，即使调用 {@link setCurrentTime} 时没有传入 `isSeek`，
  * 内部也会在进度前进时比较它的实际推进量与应有的推进量，超量前进即视为跳转
  *
  * 应有的推进量取决于当前的播放状态，因此请按 {@link pause} 与 {@link resume}
  * 的文档正确同步播放状态：
  * - 播放时以物理时钟的推进量为准，容差随之按比例放宽，以容纳倍速播放与不均匀的推送节奏
  * - 暂停时进度本不该前进，应有的推进量是零，因此任何超出抖动幅度的前进都会被视为跳转
  *
  * 这意味着进度信息的粒度粗于推送间隔时，粒度跳变的那一帧会因超量前进被视为跳转，
  * 此时应当改善进度来源的精度，或关闭此开关
  *
  * 较小的向前跳转可能无法被识别，但一般影响不大
  *
  * 此开关只控制上述超量前进的判定。进度倒退不受它控制，无论是否启用推导都会被视为跳转；
  * 进度保持不变则既不前进也不后退，不会被推导视为跳转
  *
  * 推导只会额外识别出跳转，不会否决已显式传入的跳转标志，因此如果你已经在正确传入
  * 跳转标志了，则一般无需关心此开关。若你的进度来源精度很差而导致超量前进被频繁误判，
  * 可以选择关闭
  *
  * @param enable 是否启用自动推导
  */
  setEnableAutoSeekDetection(enable = true) {
    if (this.enableAutoSeekDetection === enable) return;
    this.enableAutoSeekDetection = enable;
    this.seekDetector.reset();
  }
  /**
  * 获取当前是否启用了跳转状态的自动推导
  * @returns 是否启用自动推导
  */
  getEnableAutoSeekDetection() {
    return this.enableAutoSeekDetection;
  }
  /**
  * 设置是否隐藏已经播放过的歌词行，默认不隐藏
  * @param hide 是否隐藏已经播放过的歌词行，默认不隐藏
  */
  setHidePassedLines(hide) {
    this.hidePassedLines = hide;
    this.calcLayout(LayoutReason.ConfigChange);
  }
  /**
  * 设置是否启用歌词行的模糊效果
  * @param enable 是否启用
  */
  setEnableBlur(enable) {
    if (this.enableBlur === enable) return;
    this.enableBlur = enable;
    this.calcLayout(LayoutReason.ConfigChange);
  }
  /**
  * 批量更新歌词处理配置，包括优化和掩码设置
  *
  * @remarks
  * 此方法不会自动重建歌词行和刷新视图，
  * 适用于在渲染前预设配置、批量初始化，或需要手动控制 DOM 刷新时机的场景
  * @param config 需要更新的配置集合
  * @see {@link LyricDataConfig}
  */
  setLyricProcessConfig(config) {
    this.dataManager.setConfig(config);
  }
  /**
  * 批量更新歌词处理配置，包括优化和掩码设置
  *
  * 可以调用此方法以避免多次单独设置处理配置导致的多次刷新开销
  * @remarks 在设置完成后会自动重建歌词行和刷新视图
  * @param config 需要更新的配置集合
  * @see {@link LyricDataConfig}
  */
  updateLyricProcessConfig(config) {
    const currentOptimize = this.dataManager.getOptimizeOptions();
    const currentMaskMode = this.dataManager.getMaskMode();
    const currentMaskChar = this.dataManager.getMaskChar();
    const newOptimize = config.optimizeOptions !== void 0 ? config.optimizeOptions : currentOptimize;
    const newMaskMode = config.maskMode !== void 0 ? config.maskMode : currentMaskMode;
    const newMaskChar = config.maskChar !== void 0 ? config.maskChar : currentMaskChar;
    if (newMaskMode === currentMaskMode && newMaskChar === currentMaskChar && areOptimizeOptionsEqual(newOptimize, currentOptimize)) return;
    this.dataManager.setConfig({
      optimizeOptions: newOptimize,
      maskMode: newMaskMode,
      maskChar: newMaskChar
    });
    if (this.dataManager.getRawLines().length > 0) {
      this.rebuildLyricView(this.getCurrentTime());
      this.calcLayout(LayoutReason.ConfigChange);
    }
  }
  /**
  * 设置歌词中不雅用语的掩码模式
  * @remarks 在设置完成后会自动重建歌词行和刷新视图
  * @param mode 掩码模式
  * @see {@link MaskObsceneWordsMode}
  */
  setMaskObsceneWords(mode) {
    this.updateLyricProcessConfig({ maskMode: mode });
  }
  /**
  * 设置不雅用语掩码使用的字符，默认为 `*`
  * @remarks 在设置完成后会自动重建歌词行和刷新视图
  * @param char 单个字符，用于替换不雅用语中的字符
  */
  setMaskObsceneWordChar(char) {
    const c = char.charAt(0) || "*";
    this.updateLyricProcessConfig({ maskChar: c });
  }
  /**
  * 设置歌词的优化配置项，这些配置项默认全部开启
  * @remarks 在设置完成后会自动重建歌词行和刷新视图
  * @param options 优化配置选项
  * @see {@link OptimizeLyricOptions}
  */
  setOptimizeOptions(options) {
    const currentOpts = this.dataManager.getOptimizeOptions();
    this.updateLyricProcessConfig({ optimizeOptions: {
      ...currentOpts,
      ...options
    } });
  }
  rebuildLyricLines() {
    for (const group of this.currentLyricGroups) group.rebuildAllLines();
  }
  /**
  * 设置目标歌词行的对齐方式，默认为 `center`
  *
  * - 设置成 `top` 的话将会向目标歌词行的顶部对齐
  * - 设置成 `bottom` 的话将会向目标歌词行的底部对齐
  * - 设置成 `center` 的话将会向目标歌词行的垂直中心对齐
  * @param alignAnchor 歌词行对齐方式，详情见函数说明
  */
  setAlignAnchor(alignAnchor) {
    this.layoutConfig.alignAnchor = alignAnchor;
  }
  /**
  * 设置默认的歌词行对齐位置，相对于整个歌词播放组件的大小位置，默认为 `0.5`
  * @param alignPosition 一个 `[0.0-1.0]` 之间的任意数字，代表组件高度由上到下的比例位置
  */
  setAlignPosition(alignPosition) {
    this.layoutConfig.alignPosition = alignPosition;
  }
  /**
  * 设置 overscan（视图上下额外缓冲渲染区）距离，单位：像素。
  * @param px 像素值，默认 300
  */
  setOverscanPx(px) {
    this.layoutConfig.overscanPx = clampPositive(px | 0);
  }
  /** 获取当前 overscan 像素距离 */
  getOverscanPx() {
    return this.layoutConfig.overscanPx;
  }
  /**
  * 设置是否使用物理弹簧算法实现歌词动画效果，默认启用
  *
  * 如果启用，则会通过弹簧算法实时处理歌词位置，但是需要性能足够强劲的电脑方可流畅运行
  *
  * 如果不启用，则会回退到基于 `transition` 的过渡效果，对低性能的机器比较友好，但是效果会比较单一
  */
  setEnableSpring(enable = true) {
    this.disableSpring = !enable;
    if (enable) this.element.classList.remove(lyric_player_module_default.disableSpring);
    else this.element.classList.add(lyric_player_module_default.disableSpring);
    this.calcLayout(LayoutReason.ConfigChange);
  }
  /**
  * 获取当前是否启用了物理弹簧
  * @returns 是否启用物理弹簧
  */
  getEnableSpring() {
    return !this.disableSpring;
  }
  /**
  * 设置当前播放歌词，要注意传入后这个数组内的信息不得修改，否则会发生错误
  * @param lines 歌词数组
  * @param initialTime 初始时间，默认为 0
  * @throws {TypeError} 歌词时间戳不是有限的非负数字
  * @throws {RangeError} 任一行、单词或注音的开始时间晚于结束时间
  */
  setLyricLines(lines, initialTime = 0) {
    if (true) console.log("\u8BBE\u7F6E\u6B4C\u8BCD\u884C", lines, initialTime);
    this.dataManager.setOriginalLines(lines);
    this.rebuildLyricView(initialTime);
  }
  /**
  * 获取当前是否在播放
  * @returns 当前是否在播放
  */
  getIsPlaying() {
    return this.isPlaying;
  }
  /**
  * 设置当前播放进度，此时将会更新内部的歌词进度信息。
  *
  * 内部会根据调用间隔和播放进度自动决定应如何滚动和显示歌词，所以此方法的调用频率越快越准确越好。
  * 调用频率较低或进度细度过粗可能会导致歌词显示延迟或导致自动跳转推导错误。
  * 调用完成后，应每帧调用 {@link update} 方法来执行歌词动画效果。此函数本身不会触发动画效果。
  *
  * 当 `isSeek` 为 `true` 时，将强制按跳转处理，并在下次调用 {@link update} 时触发一系列的行为变更，
  * 具体请参考 <https://amll.dev/guides/component/seeking>，因此请只在真正跳转时设为 `true`
  *
  * @param time 当前播放进度，单位为毫秒，非有限值会被静默忽略
  * @param isSeek 是否强制按跳转处理，默认交由内部推导
  * @see {@link setEnableAutoSeekDetection} 自动推导跳转状态的文档
  * @see https://amll.dev/guides/component/sequence#播放进度
  */
  setCurrentTime(time, isSeek = false) {
    if (!Number.isFinite(time)) return;
    const mediaTime = MediaTime.round(MediaTime.fromMillis(time));
    const isDetectedSeek = this.enableAutoSeekDetection ? this.seekDetector.detect(mediaTime, this.isPlaying) : false;
    this.syncTime(mediaTime, isSeek || isDetectedSeek);
  }
  /**
  * 推进时间线并把增量变化应用到视图上
  * @param mediaTime 当前播放进度
  * @param isSeek 这次进度变化是否为跳转
  */
  syncTime(mediaTime, isSeek) {
    const wasFocusOnInterlude = this.timelineController.getSnapshot().isFocusOnInterlude;
    const diff = this.timelineController.sync(mediaTime, isSeek);
    this.interludeDots.syncClock(mediaTime);
    if (!diff.hasChanged) return;
    const isTimeJumped = diff.isTimeJumped;
    const snapshot = this.timelineController.getSnapshot();
    for (let i = 0; i < diff.removedHighlighted.length; i++) this.currentLyricGroups[diff.removedHighlighted[i]]?.disable();
    if (isTimeJumped) for (const index of snapshot.highlightedGroups) this.currentLyricGroups[index]?.enable();
    else for (let i = 0; i < diff.addedHighlighted.length; i++) this.currentLyricGroups[diff.addedHighlighted[i]]?.enable();
    if (isTimeJumped) {
      if (!this.scrollState.isTouchScrolled) this.resetScroll();
    } else if ((diff.isScrollToChanged || wasFocusOnInterlude) && !snapshot.isFocusOnInterlude && snapshot.playingGroups.has(snapshot.scrollToIndex) && this.scrollState.isAutoAlignSuspended && this.scrollEngine.canResumeAutoAlign && this.currentLyricGroups[snapshot.scrollToIndex]?.isInRenderRange(false)) this.resetScroll();
    if (diff.isInterludeChanged || diff.isScrollToChanged || diff.isEndOfSongChanged || isTimeJumped) this.updateSpringParams(!!snapshot.activeInterlude, isTimeJumped, snapshot.isEndOfSong);
    this.calcLayout(isTimeJumped ? LayoutReason.Seek : LayoutReason.PlaybackTick);
  }
  /**
  * 重新构建歌词行和时间状态
  *
  * 一般用于在调用 {@link setLyricProcessConfig} 更新配置后手动刷新视图，
  * 或在外部样式/DOM 结构发生改变后重置歌词视图
  *
  * @param initialTime 重建后对齐的初始时间（毫秒），默认使用当前播放进度
  */
  rebuildLyricView(initialTime = this.getCurrentTime()) {
    this.resetScroll();
    this.focusController.reset();
    if (this.getBottomLineElement().innerHTML.trim().length > 0) this.bottomLine.resetPosition();
    for (const group of this.currentLyricGroups) group.dispose();
    this.currentLyricGroups = [];
    this.interludeDots.clearInterlude(true);
    this.buildLyricGroups();
    this.currentLyricGroups.sort((a, b) => MediaTime.cmp(a.startTime, b.startTime));
    for (let i = 0; i < this.currentLyricGroups.length; i++) this.lyricGroupIndexMap.set(this.currentLyricGroups[i], i);
    const bounds = this.currentLyricGroups.map((group) => ({
      startTime: group.startTime,
      endTime: group.endTime
    }));
    this.timelineController.setTimeBounds(bounds);
    this.layoutCalculator.initHeights(this.currentLyricGroups.length, this.defaultLineHeight);
    this.seekDetector.reset();
    this.setCurrentTime(initialTime, true);
    this.calcLayout(LayoutReason.RebuildView);
    if (true) console.log("\u6B4C\u8BCD\u89C6\u56FE\u91CD\u5EFA\u5B8C\u6210", this);
  }
  /**
  * 更新歌词纵向滚动动画的弹簧参数。
  *
  * 其策略为：
  * - seeking 或间奏时使用更稳定的固定参数
  * - 普通播放时根据相邻歌词的时间间隔动态调整 stiffness / damping
  * - 播放完毕时使用中速弹簧参数
  *
  * @param isInterludeActive 当前是否命中间奏区间
  * @param isSeeking 本次同步的时间轴是否发生了跳转
  * @param isEndOfSong 歌曲是否播放完毕
  */
  updateSpringParams(isInterludeActive, isSeeking, isEndOfSong) {
    if (!this.getEnableSpring() || this.currentLyricGroups.length === 0) return;
    const { scrollToIndex } = this.timelineController.getSnapshot();
    const currentGroup = this.currentLyricGroups[scrollToIndex];
    const prevGroup = this.currentLyricGroups[scrollToIndex - 1];
    let interval;
    if (currentGroup && prevGroup) interval = Duration.asMillis(MediaTime.since(currentGroup.startTime, prevGroup.startTime));
    const policy = getPosYSpringPolicy(isSeeking, isInterludeActive, interval, isEndOfSong);
    this.setLinePosYSpringParams(policy);
  }
  /**
  * 重新计算歌词行的几何排版坐标与视觉状态
  *
  * 此方法不会触发 DOM 强制重排
  *
  * 计算完成后，在每一帧调用 `update()` / `commitChanges()` 即可让歌词平滑移动至目标位置
  *
  * @internal 仅供内部和绑定包使用
  * @param reason 触发排版布局更新的原因场景
  */
  calcLayout(reason) {
    const strategy = LayoutReasonStrategyMap[reason];
    const snapshot = this.timelineController.getSnapshot();
    const interlude = snapshot.activeInterlude;
    let canDisplayInterlude = false;
    if (interlude) canDisplayInterlude = this.interludeDots.setInterlude([interlude.startTime, interlude.endTime], snapshot.currentTime, strategy.resetInterlude, interlude.anchorLineIndex);
    else this.interludeDots.clearInterlude();
    const focalTarget = this.focusController.resolve(snapshot, this.currentLyricGroups.length, {
      isAutoAlignSuspended: this.scrollState.isAutoAlignSuspended,
      hasBottomContent: this.hasBottomContent,
      canDisplayInterlude
    });
    const dotMargin = (this.baseFontSize || 24) * 0.4;
    const totalInterludeHeight = this.layoutState.interludeDotsSize[1] + dotMargin * 2;
    const ctx = this.frameContext;
    ctx.containerHeight = this.size[1];
    ctx.target = focalTarget;
    ctx.bottomLineHeight = this.bottomLine.lineSize[1] || 0;
    const activeInterludeForLayout = canDisplayInterlude ? interlude : void 0;
    const interludeAnchorIndex = LayoutCalculator.resolveInterludeAnchorIndex(activeInterludeForLayout, focalTarget);
    if (interludeAnchorIndex !== void 0) {
      ctx.interlude = ctx.interlude || {
        totalHeight: 0,
        anchorIndex: 0
      };
      ctx.interlude.totalHeight = totalInterludeHeight;
      ctx.interlude.anchorIndex = interludeAnchorIndex;
    } else ctx.interlude = void 0;
    const { bounds, session } = this.layoutCalculator.beginFrame(ctx, this.layoutConfig);
    ctx.scrollOffset = this.scrollEngine.updateBoundary(bounds.min, bounds.max);
    const result = this.layoutCalculator.commit(session, ctx.scrollOffset);
    if (result.hasInterlude && canDisplayInterlude && interlude) {
      const nextLineIndex = interlude.anchorLineIndex + 1;
      const targetX = this.currentLyricGroups[nextLineIndex]?.mainLine.getLine().isDuet ?? false ? this.size[0] - this.layoutState.interludeDotsSize[0] : 0;
      this.interludeDots.setTransform(targetX, result.interludeY + dotMargin, strategy.snapPosY || !this.getEnableSpring());
    }
    const visual = this.visualFrame;
    visual.latestIndex = snapshot.latestHighlightedIndex ?? snapshot.scrollToIndex;
    visual.passedBoundary = interlude ? interlude.anchorLineIndex + 1 : snapshot.scrollToIndex;
    visual.isNarrowViewport = window.innerWidth <= 1024;
    const activeCount = result.lineCount;
    let delay = Duration.ZERO;
    let baseDelay = strategy.disableStagger ? Duration.ZERO : Duration.fromSecs(0.05);
    for (let i = 0; i < activeCount; i++) {
      const group = this.currentLyricGroups[i];
      const instruction = result.lineInstructions[i];
      const curPos = instruction.y;
      const isInViewport = instruction.isInViewport;
      const isActive = this.resolveIsActive(i, snapshot);
      group.setTransform(curPos, strategy.snapPosY, delay, isActive, this.resolveOpacity(i, isInViewport, snapshot), this.resolveBlurLevel(i, isActive, isInViewport, snapshot));
      if (curPos + instruction.height >= 0) {
        delay = Duration.add(delay, baseDelay);
        if (i >= snapshot.scrollToIndex) baseDelay = Duration.mulF64(baseDelay, 1 / 1.05);
      }
    }
    const isBottomFocused = focalTarget.type === "bottom";
    this.bottomLine.setFocused(isBottomFocused);
    this.bottomLine.setTransform(result.bottomLineY, this.resolveBlurLevel(activeCount, isBottomFocused, result.isBottomLineInViewport, snapshot), strategy.snapPosY, delay);
  }
  /**
  * 推导某一行是否处于激活状态
  * @param index 歌词行索引
  * @param snapshot 当前帧的时间线快照
  */
  resolveIsActive(index, snapshot) {
    return snapshot.highlightedGroups.has(index) || index >= snapshot.scrollToIndex && index < this.visualFrame.latestIndex;
  }
  /**
  * 推导一行的目标透明度
  * @param index 歌词行索引
  * @param isInViewport 该行是否在可视区域内
  * @param snapshot 当前帧的时间线快照
  */
  resolveOpacity(index, isInViewport, snapshot) {
    if (!isInViewport) return 0;
    if (this.hidePassedLines && this.isPlaying && index < this.visualFrame.passedBoundary) return 1e-4;
    if (snapshot.highlightedGroups.has(index)) return 0.85;
    return this.isNonDynamic ? 0.2 : 1;
  }
  /**
  * 按距焦点的行距推导模糊档位
  * @param index 歌词行索引，底栏传入歌词总行数
  * @param isFocused 该目标是否为当前焦点，歌词行传 `isActive`，底栏传是否聚焦底栏
  * @param isInViewport 该目标是否在可视区域内
  * @param snapshot 当前帧的时间线快照
  */
  resolveBlurLevel(index, isFocused, isInViewport, snapshot) {
    if (!this.enableBlur) return 0;
    if (!isInViewport) return 5;
    if (this.scrollState.isTouchScrolled || isFocused) return 0;
    const scrollToIndex = snapshot.scrollToIndex;
    const level = 1 + (index < scrollToIndex ? Math.abs(scrollToIndex - index) + 1 : Math.abs(index - this.visualFrame.latestIndex));
    return this.visualFrame.isNarrowViewport ? level * 0.8 : level;
  }
  /**
  * 设置所有歌词行、底栏和间奏点在横坐标上的弹簧属性，包括重量、弹力和阻力。
  *
  * @param params 需要设置的弹簧属性，提供的属性将会覆盖原来的属性，未提供的属性将会保持原样
  * @deprecated 考虑到横向弹簧效果并不常见，所以这个函数将会在未来的版本中移除
  */
  setLinePosXSpringParams(_params = {}) {
  }
  /**
  * 设置所有歌词行、底栏和间奏点在​纵坐标上的弹簧属性，包括重量、弹力和阻力。
  *
  * @param params 需要设置的弹簧属性，提供的属性将会覆盖原来的属性，未提供的属性将会保持原样
  */
  setLinePosYSpringParams(params = {}) {
    this.posYSpringParams = {
      ...this.posYSpringParams,
      ...params
    };
    this.bottomLine.lineTransforms.posY.updateParams(this.posYSpringParams);
    this.interludeDots.posY.updateParams(this.posYSpringParams);
    for (const group of this.currentLyricGroups) {
      group.posY.updateParams(this.posYSpringParams);
      group.bgSlideY.updateParams(this.posYSpringParams);
    }
  }
  /**
  * 设置所有歌词行在​缩放大小上的弹簧属性，包括重量、弹力和阻力。
  *
  * @param params 需要设置的弹簧属性，提供的属性将会覆盖原来的属性，未提供的属性将会保持原样
  */
  setLineScaleSpringParams(params = {}) {
    this.scaleSpringParams = {
      ...this.scaleSpringParams,
      ...params
    };
    this.scaleForBGSpringParams = {
      ...this.scaleForBGSpringParams,
      ...params
    };
    for (const group of this.currentLyricGroups) {
      group.mainLine.lineTransforms.scale.updateParams(this.scaleSpringParams);
      group.bgLine?.lineTransforms.scale.updateParams(this.scaleForBGSpringParams);
    }
  }
  /**
  * 暂停部分效果演出，目前会暂停播放间奏点的动画，且将背景歌词显示出来
  */
  pause() {
    this.interludeDots.pause();
    if (this.isPlaying) {
      this.isPlaying = false;
      this.calcLayout(LayoutReason.ConfigChange);
    }
  }
  /**
  * 恢复部分效果演出，目前会恢复播放间奏点的动画
  */
  resume() {
    this.interludeDots.resume();
    if (!this.isPlaying) {
      this.isPlaying = true;
      this.calcLayout(LayoutReason.ConfigChange);
    }
  }
  /**
  * 更新动画，这个函数应该被逐帧调用或者在以下情况下调用一次：
  *
  * 1. 刚刚调用完设置歌词函数的时候
  * @param delta 距离上一次被调用到现在的时长，单位为毫秒（可为浮点数）
  */
  update(delta = 0) {
    const d = Duration.min(Duration.fromMillis(delta), MAX_FRAME_DELTA);
    this.bottomLine.update(d);
    this.interludeDots.update(d);
  }
  onResize() {
  }
  /**
  * 获取一个特殊的底栏元素，默认是空白的，可以往内部添加任意元素
  *
  * 这个元素始终在歌词的底部，可以用于显示歌曲创作者等信息
  *
  * 但是请勿删除该元素，只能在内部存放元素
  *
  * @returns 一个元素，可以往内部添加任意元素
  */
  getBottomLineElement() {
    return this.bottomLine.getContentElement?.() ?? this.bottomLine.getElement();
  }
  /**
  * 重置用户滚动状态并恢复自动对齐
  *
  * 一个典型的使用场景是在用户滚动完毕、但歌词未自动归位时立刻归位
  */
  resetScroll() {
    this.scrollEngine.resetScroll(0);
    this.scrollState.isAutoAlignSuspended = false;
    this.scrollState.isTouchScrolled = false;
  }
  /**
  * 获取当前播放的、未经过优化和掩码处理的歌词数组
  *
  * 一般和最后调用 `setLyricLines` 给予的参数一样
  * @returns 当前歌词数组
  */
  getLyricLines() {
    return this.dataManager.getRawLines();
  }
  /**
  * 获取当前歌词的播放位置
  *
  * 一般和最后调用 `setCurrentTime` 给予的参数一样
  * @returns 当前播放位置
  */
  getCurrentTime() {
    return MediaTime.asMillis(this.timelineController.getSnapshot().currentTime);
  }
  /**
  * 设置是否让背景人声行始终后置显示
  *
  * 默认情况下，如果背景歌词开始时间早于主歌词，会在主歌词上方展示；
  * 如果设置为 `true`，则无论时间顺序如何，背景歌词都会始终在主歌词下方展示
  * @param enable 是否启用始终后置
  */
  setAlwaysPostpositionBackground(enable) {
    if (this.alwaysPostpositionBackground === enable) return;
    this.alwaysPostpositionBackground = enable;
    this.rebuildLyricLines();
    this.calcLayout(LayoutReason.ConfigChange);
  }
  /** 获取当前是否设置了让背景人声行始终后置显示 */
  getAlwaysPostpositionBackground() {
    return this.alwaysPostpositionBackground;
  }
  getElement() {
    return this.element;
  }
  dispose() {
    this.scrollEngine.dispose();
    this.element.remove();
    this.bottomLineObserver.disconnect();
    this.interludeDots.dispose();
    this.bottomLine.dispose();
    window.removeEventListener("pageshow", this.onPageShow);
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }
};
function derivative(f) {
  const h = 1e-3;
  return (x) => (f(x + h) - f(x - h)) / (2 * h);
}
function getVelocity(f) {
  return derivative(f);
}
var spring_exports = /* @__PURE__ */ __exportAll({ Spring: () => Spring });
var Spring = class {
  currentPosition = 0;
  targetPosition = 0;
  currentTime = 0;
  params = {};
  currentSolver;
  getV;
  getV2;
  queueParams;
  queuePosition;
  constructor(currentPosition = 0) {
    this.targetPosition = currentPosition;
    this.currentPosition = this.targetPosition;
    this.currentSolver = () => this.targetPosition;
    this.getV = () => 0;
    this.getV2 = () => 0;
  }
  resetSolver() {
    const curV = this.getV(this.currentTime);
    this.currentTime = 0;
    this.currentSolver = solveSpring(this.currentPosition, curV, this.targetPosition, 0, this.params);
    this.getV = getVelocity(this.currentSolver);
    this.getV2 = getVelocity(this.getV);
  }
  arrived() {
    return Math.abs(this.targetPosition - this.currentPosition) < 0.01 && Math.abs(this.getV(this.currentTime)) < 0.01 && Math.abs(this.getV2(this.currentTime)) < 0.01 && this.queueParams === void 0 && this.queuePosition === void 0;
  }
  setPosition(targetPosition) {
    this.targetPosition = targetPosition;
    this.currentPosition = targetPosition;
    this.currentSolver = () => this.targetPosition;
    this.getV = () => 0;
    this.getV2 = () => 0;
  }
  update(delta = Duration.ZERO) {
    const dt = Duration.asSecsF64(delta);
    this.currentTime += dt;
    this.currentPosition = this.currentSolver(this.currentTime);
    if (this.queueParams) {
      this.queueParams.time -= dt;
      if (this.queueParams.time <= 0) this.updateParams({ ...this.queueParams });
    }
    if (this.queuePosition) {
      this.queuePosition.time -= dt;
      if (this.queuePosition.time <= 0) this.setTargetPosition(this.queuePosition.position);
    }
    if (this.arrived()) this.setPosition(this.targetPosition);
  }
  updateParams(params, delay = Duration.ZERO) {
    const delaySecs = Duration.asSecsF64(delay);
    if (delaySecs > 0) this.queueParams = {
      ...this.queuePosition ?? {},
      ...params,
      time: delaySecs
    };
    else {
      this.queuePosition = void 0;
      this.params = {
        ...this.params,
        ...params
      };
      this.resetSolver();
    }
  }
  setTargetPosition(targetPosition, delay = Duration.ZERO) {
    const delaySecs = Duration.asSecsF64(delay);
    if (delaySecs <= 0 && Math.abs(this.targetPosition - targetPosition) < 1e-3) {
      this.queuePosition = void 0;
      return;
    }
    if (delaySecs > 0) this.queuePosition = {
      ...this.queuePosition ?? {},
      position: targetPosition,
      time: delaySecs
    };
    else {
      this.queuePosition = void 0;
      this.targetPosition = targetPosition;
      this.resetSolver();
    }
  }
  getCurrentPosition() {
    return this.currentPosition;
  }
};
function solveSpring(from, velocity, to, delay = 0, params) {
  const soft = params?.soft ?? false;
  const stiffness = params?.stiffness ?? 100;
  const damping = params?.damping ?? 10;
  const mass = params?.mass ?? 1;
  const delta = to - from;
  if (soft || 1 <= damping / (2 * Math.sqrt(stiffness * mass))) {
    const angular_frequency = -Math.sqrt(stiffness / mass);
    const leftover2 = -angular_frequency * delta - velocity;
    return (t) => {
      t -= delay;
      if (t < 0) return from;
      return to - (delta + t * leftover2) * Math.E ** (t * angular_frequency);
    };
  }
  const damping_frequency = Math.sqrt(4 * mass * stiffness - damping ** 2);
  const leftover = (damping * delta - 2 * mass * velocity) / damping_frequency;
  const dfm = 0.5 * damping_frequency / mass;
  const dm = -(0.5 * damping) / mass;
  return (t) => {
    t -= delay;
    if (t < 0) return from;
    return to - (Math.cos(t * dfm) * delta + Math.sin(t * dfm) * leftover) * Math.E ** (t * dm);
  };
}
var BottomLineEl = class {
  lyricPlayer;
  element = document.createElement("div");
  contentElement = document.createElement("div");
  top = 0;
  isFocused = false;
  blur = 0;
  lastTransformStyle = "";
  lastFilterStyle = "";
  lineTransforms = { posY: new Spring(0) };
  /**
  * 底栏当前测量得到的尺寸
  *
  * 由播放器的 ResizeObserver 回调写入
  */
  lineSize = [0, 0];
  constructor(lyricPlayer) {
    this.lyricPlayer = lyricPlayer;
    this.element.setAttribute("class", `${lyric_player_module_default.lyricLineWrapper} ${lyric_player_module_default.bottomLineWrapper}`);
    this.contentElement.setAttribute("class", `${lyric_player_module_default.lyricLine} ${lyric_player_module_default.bottomLine}`);
    this.contentElement.dataset.bottomLine = "true";
    this.element.appendChild(this.contentElement);
    this.rebuildStyle();
  }
  getElement() {
    return this.element;
  }
  getContentElement() {
    return this.contentElement;
  }
  resetPosition() {
    this.lineTransforms.posY.setPosition(window.innerHeight * 2);
    this.rebuildStyle();
  }
  /**
  * 设置底栏是否处于聚焦状态
  *
  * 一般在歌曲播放完毕且底栏有内容时聚焦到底栏并设为 true
  */
  setFocused(focused) {
    if (this.isFocused !== focused) {
      this.isFocused = focused;
      this.contentElement.classList.toggle(lyric_player_module_default.gradientMask, focused);
      if (focused) this.element.dataset.focused = "true";
      else delete this.element.dataset.focused;
    }
  }
  setTransform(top = this.top, blur = 0, immediate = false, delay = Duration.ZERO) {
    this.top = top;
    if (immediate || !this.lyricPlayer.getEnableSpring()) {
      this.blur = Math.min(32, blur);
      if (immediate) this.element.classList.add(lyric_player_module_default.tmpDisableTransition);
      this.lineTransforms.posY.setPosition(top);
      this.rebuildStyle();
      if (immediate) requestAnimationFrame(() => {
        this.element.classList.remove(lyric_player_module_default.tmpDisableTransition);
      });
    } else {
      this.blur = Math.min(5, blur);
      this.lineTransforms.posY.setTargetPosition(top, delay);
    }
  }
  /**
  * 逐帧推进弹簧动画并应用样式
  * @param delta 距离上一次调用的时长
  */
  update(delta = Duration.ZERO) {
    if (!this.lyricPlayer.getEnableSpring()) return;
    this.lineTransforms.posY.update(delta);
    this.rebuildStyle();
  }
  /**
  * 将弹簧当前位置与模糊值写入内联样式
  */
  rebuildStyle() {
    const style = this.element.style;
    const transformStr = `translate(0px, ${this.lineTransforms.posY.getCurrentPosition().toFixed(2)}px)`;
    if (this.lastTransformStyle !== transformStr) {
      this.lastTransformStyle = transformStr;
      style.transform = transformStr;
    }
    const blurVal = Math.min(5, this.blur);
    const filterStr = blurVal > 0.01 ? `blur(${blurVal.toFixed(2)}px)` : "none";
    if (this.lastFilterStyle !== filterStr) {
      this.lastFilterStyle = filterStr;
      style.filter = filterStr;
    }
  }
  dispose() {
    this.element.remove();
  }
};
var DOT3_TRAILING_MS = 750;
var EXIT_PHASE1_MS = 750;
var EXIT_PHASE2_MS = 250;
var EXIT_TOTAL_MS = 1e3;
var EXIT_FADE_MS = 250;
var DISMISS_FADE_MS = 150;
var ENTER_HOLD_MS = 500;
var ENTER_FADE_MS = 180;
var DOT_ENTER_FADE_MS = 750;
var DOT_ENTER_STAGGER_MS = 80;
var DOT_ENTER_TOTAL_MS = 910;
var BREATHE_BASE_PERIOD_MS = 4e3;
var FALLBACK_HOLD_THRESHOLD_MS = 3e3;
var BREATHE_MAX_SCALE = 1.25;
var DOT_INACTIVE_OPACITY = 0.2;
var DOT_COUNT = 3;
var lightingEasing = bezier(0.56, 0.01, 0.45, 1);
var enterFadeEasing = bezier(0.59, 0.02, 0.07, 1);
var exitPhase1Easing = bezier(0.14, 0.06, 0.25, 1);
var exitPhase2Easing = bezier(0.29, 0.03, 1, 0.38);
var exitFadeEasing = bezier(0.43, 0.08, 0.83, 0.31);
var HIDDEN_SNAPSHOT = {
  isActive: false,
  dotOpacities: [
    0,
    0,
    0
  ],
  scale: 1,
  opacity: 0
};
var InterludeDotsBase = class {
  left = 0;
  top = 0;
  posY = new Spring(0);
  /**
  * 下一次设置变换位置时是否直接吸附到目标位置
  *
  * 演出重建或位置跳变时新旧坐标可能相距很远，走弹簧会看到间奏点从旧位置滑入的残影
  */
  shouldSnapPosY = true;
  currentTime = MediaTime.ZERO;
  playing = true;
  phase = "idle";
  mode = "breathe";
  fadeElapsedMs = 0;
  fadeInitialOpacity = 0;
  startTime = MediaTime.ZERO;
  endTime = MediaTime.ZERO;
  anchorTime = MediaTime.ZERO;
  delayEndMs = 0;
  bodyEndMs = 0;
  totalEndMs = 0;
  breathePeriodMs = BREATHE_BASE_PERIOD_MS;
  segmentMs = 0;
  dot3DurationMs = 0;
  dot3Target = 0;
  mutDotOpacities = [
    0,
    0,
    0
  ];
  snapshot = {
    isActive: true,
    dotOpacities: this.mutDotOpacities,
    scale: 1,
    opacity: 0
  };
  /**
  * 设置间奏区间并锚定演出时间
  *
  * @param interlude 间奏起止时间
  * @param currentTime 当前播放时间，用于把演出重锚到该时刻；未传入时使用间奏起点
  * @param forceReset 是否强制重建演出，如跳转播放进度或重建歌词视图时
  * @param anchorLineIndex 间奏锚定的歌词行索引
  * @returns 本次间奏是否有足够时长显示间奏点
  */
  setInterlude(interlude, currentTime, forceReset = false, anchorLineIndex = 0) {
    const [startTime, endTime] = interlude;
    const isSameInterlude = this.startTime === startTime && this.endTime === endTime;
    if (!forceReset && isSameInterlude && this.phase !== "fading") return this.phase === "performing";
    this.cancelFadeOut();
    this.startTime = startTime;
    this.endTime = endTime;
    this.currentTime = currentTime ?? startTime;
    if (forceReset) {
      this.anchorTime = this.currentTime;
      this.delayEndMs = ENTER_HOLD_MS;
    } else {
      this.anchorTime = startTime;
      this.delayEndMs = anchorLineIndex === -1 ? 0 : ENTER_HOLD_MS;
    }
    const bodyMs = Math.max(0, Duration.asMillis(MediaTime.since(endTime, this.anchorTime))) - this.delayEndMs - EXIT_TOTAL_MS;
    if (bodyMs < DOT_ENTER_TOTAL_MS) {
      this.hidePerformance();
      return false;
    }
    this.bodyEndMs = this.delayEndMs + bodyMs;
    this.totalEndMs = this.bodyEndMs + EXIT_TOTAL_MS;
    let mode;
    if (bodyMs < FALLBACK_HOLD_THRESHOLD_MS) {
      mode = "fallback-hold";
      this.dot3Target = 1;
    } else {
      mode = "breathe";
      const breatheCycles = Math.max(1, Math.floor(bodyMs / BREATHE_BASE_PERIOD_MS));
      this.breathePeriodMs = bodyMs / breatheCycles;
      this.segmentMs = Math.round((bodyMs + DOT3_TRAILING_MS) / DOT_COUNT);
      this.dot3DurationMs = bodyMs - this.segmentMs * 2;
      this.dot3Target = this.dot3DurationMs / this.segmentMs;
    }
    this.enterPerforming(mode);
    return true;
  }
  /**
  * 清空间奏区间并终止当前演出
  *
  * 与 {@link dismiss} 的区别在于本方法会一并抹去区间状态，
  * 使此后重新进入同一间奏区间时能够重新演出
  *
  * @param immediate 是否立即隐藏而非淡出
  */
  clearInterlude(immediate = false) {
    this.startTime = MediaTime.ZERO;
    this.endTime = MediaTime.ZERO;
    this.dismiss(immediate);
  }
  /**
  * 结束间奏点演出，默认使用 150ms 淡出
  * @param immediate 是否立即隐藏
  */
  dismiss(immediate = false) {
    if (this.phase === "idle") return;
    if (immediate || !this.playing) {
      this.cancelFadeOut();
      this.hidePerformance();
      return;
    }
    if (this.phase === "fading") return;
    if (this.snapshot.opacity <= 0) {
      this.hidePerformance();
      return;
    }
    this.enterFading();
  }
  /**
  * 设置间奏点的变换位置并立即刷新一次
  * @param left 横向位置
  * @param top 纵向位置
  * @param immediate 是否绕过弹簧直接跳转到目标位置，用于触摸拖动等需要跟手的场景
  */
  setTransform(left = this.left, top = this.top, immediate = false) {
    this.left = left;
    this.top = top;
    if (!immediate && this.phase !== "idle" && !this.shouldSnapPosY) this.posY.setTargetPosition(top);
    else {
      this.shouldSnapPosY = false;
      this.posY.setPosition(top);
    }
    this.update();
  }
  pause() {
    this.playing = false;
    if (this.phase === "fading") this.hidePerformance();
  }
  resume() {
    this.playing = true;
  }
  /**
  * 把演出时钟对齐到指定的媒体时间，由宿主每次推送播放进度时调用
  */
  syncClock(time) {
    this.currentTime = time;
  }
  /**
  * 逐帧推进演出并把当前帧交给子类渲染
  * @param delta 距离上一次调用的物理时长
  */
  update(delta = Duration.ZERO) {
    if (this.phase === "idle") return;
    if (this.phase === "fading") {
      this.updateFadeOut(delta);
      return;
    }
    if (this.playing) this.currentTime = MediaTime.add(this.currentTime, delta);
    const elapsed = Duration.max(Duration.ZERO, MediaTime.since(this.currentTime, this.anchorTime));
    const snapshot = this.resolveSnapshot(elapsed);
    this.posY.update(delta);
    this.render(snapshot, this.left, this.posY.getCurrentPosition());
    if (!snapshot.isActive) this.enterIdle();
  }
  /**
  * 释放演出状态
  */
  dispose() {
    this.dismiss(true);
  }
  /**
  * 进入演出阶段并确定编排方式
  *
  * 演出重建后的第一帧位置由外部重新给出，不参与弹簧过渡，
  * 因此一并重置 {@link shouldSnapPosY}
  */
  enterPerforming(mode) {
    this.mode = mode;
    this.phase = "performing";
    this.shouldSnapPosY = true;
  }
  /**
  * 进入淡出阶段，冻结当前帧的不透明度作为衰减起点
  */
  enterFading() {
    this.fadeElapsedMs = 0;
    this.fadeInitialOpacity = this.snapshot.opacity;
    this.phase = "fading";
  }
  /**
  * 结束演出，回到既不推进时钟也不渲染的静止状态
  */
  enterIdle() {
    this.phase = "idle";
  }
  /**
  * 取消正在进行的淡出
  *
  * 只清掉淡出阶段，演出阶段保持原样，随后的收尾仍需据此判断
  * 是否有可见内容要派发隐藏快照
  */
  cancelFadeOut() {
    if (this.phase === "fading") this.enterIdle();
  }
  /**
  * 演出被取消时立即隐藏渲染物并清空演出状态
  */
  hidePerformance() {
    const wasActive = this.phase !== "idle";
    this.enterIdle();
    if (wasActive) this.render(HIDDEN_SNAPSHOT, this.left, this.posY.getCurrentPosition());
  }
  /**
  * 写入三颗圆点当前帧的不透明度
  *
  * 最终不透明度由点亮分数映射的透明度与各圆点的错峰入场系数相乘得到
  *
  * @param internalMs 距演出开始的经过时间
  * @param fractions 三颗圆点各自的点亮分数（0~1）
  */
  writeDotOpacities(internalMs, fractions) {
    this.mutDotOpacities[0] = dotOpacity(fractions[0]) * dotEnterAlpha(0, internalMs);
    this.mutDotOpacities[1] = dotOpacity(fractions[1]) * dotEnterAlpha(1, internalMs);
    this.mutDotOpacities[2] = dotOpacity(fractions[2]) * dotEnterAlpha(2, internalMs);
  }
  /**
  * 物理淡出步进器
  */
  updateFadeOut(delta) {
    this.fadeElapsedMs += Duration.asMillis(delta);
    const progress = clamp01(this.fadeElapsedMs / DISMISS_FADE_MS);
    if (progress >= 1) {
      this.hidePerformance();
      return;
    }
    this.snapshot.opacity = this.fadeInitialOpacity * (1 - exitFadeEasing(progress));
    this.snapshot.isActive = true;
    this.posY.update(delta);
    this.render(this.snapshot, this.left, this.posY.getCurrentPosition());
  }
  /**
  * 按经过时间求出该时刻的视觉状态
  *
  * @remarks 返回的快照对象是内部复用的同一引用，必须在当前帧内消费完毕
  * @param elapsed 距离本次演出时间锚点的经过时间
  */
  resolveSnapshot(elapsed) {
    const elapsedMs = Duration.asMillis(elapsed);
    if (elapsedMs >= this.totalEndMs) {
      this.snapshot.isActive = false;
      this.snapshot.scale = 1;
      this.snapshot.opacity = 0;
      this.mutDotOpacities[0] = 0;
      this.mutDotOpacities[1] = 0;
      this.mutDotOpacities[2] = 0;
      return this.snapshot;
    }
    this.snapshot.isActive = true;
    if (elapsedMs < this.delayEndMs) {
      this.snapshot.opacity = 0;
      this.snapshot.scale = 1;
      this.mutDotOpacities[0] = 0;
      this.mutDotOpacities[1] = 0;
      this.mutDotOpacities[2] = 0;
      return this.snapshot;
    }
    const internalMs = elapsedMs - this.delayEndMs;
    const fractionAt = (startDelay, duration, target) => computeDotFraction(startDelay, duration, internalMs, target);
    if (elapsedMs >= this.bodyEndMs) {
      const exitElapsedMs = elapsedMs - this.bodyEndMs;
      const fadeT = clamp01((exitElapsedMs - 750) / EXIT_FADE_MS);
      this.snapshot.opacity = enterOpacity(internalMs) * (1 - exitFadeEasing(fadeT));
      if (exitElapsedMs < EXIT_PHASE1_MS) this.snapshot.scale = 1 + exitPhase1Easing(exitElapsedMs / EXIT_PHASE1_MS) * 0.25;
      else {
        const phase2T = clamp01((exitElapsedMs - EXIT_PHASE1_MS) / EXIT_PHASE2_MS);
        this.snapshot.scale = BREATHE_MAX_SCALE - exitPhase2Easing(phase2T) * 0.85;
      }
      const trailing = clamp01(exitElapsedMs / DOT3_TRAILING_MS);
      this.writeDotOpacities(internalMs, [
        1,
        1,
        this.dot3Target + (1 - this.dot3Target) * trailing
      ]);
      return this.snapshot;
    }
    this.snapshot.opacity = enterOpacity(internalMs);
    if (this.mode === "fallback-hold") {
      this.snapshot.scale = 1;
      this.writeDotOpacities(internalMs, [
        1,
        1,
        1
      ]);
      return this.snapshot;
    }
    const progress = breathingProgress(internalMs % this.breathePeriodMs / this.breathePeriodMs);
    this.snapshot.scale = progress <= 0.5 ? 1 + progress / 0.5 * 0.25 : BREATHE_MAX_SCALE - (progress - 0.5) / 0.5 * 0.25;
    this.writeDotOpacities(internalMs, [
      fractionAt(0, this.segmentMs, 1),
      fractionAt(this.segmentMs, this.segmentMs, 1),
      fractionAt(this.segmentMs * 2, this.dot3DurationMs, this.dot3Target)
    ]);
    return this.snapshot;
  }
};
function breathingProgress(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const angle = 4 * Math.PI * t;
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return t - 0.084 * s + 8e-3 * (1 - c) + 46e-4 * s * (c - s);
}
function dotOpacity(fraction) {
  return DOT_INACTIVE_OPACITY + 0.7 * clamp01(fraction);
}
function enterOpacity(internalMs) {
  return enterFadeEasing(clamp01(internalMs / ENTER_FADE_MS));
}
function dotEnterAlpha(index, internalMs) {
  const t = clamp01((internalMs - index * DOT_ENTER_STAGGER_MS) / DOT_ENTER_FADE_MS);
  return t * t;
}
function computeDotFraction(startDelay, duration, internalMs, target) {
  if (internalMs <= startDelay) return 0;
  const localT = (internalMs - startDelay) / duration;
  return lightingEasing(clamp01(localT)) * target;
}
var InterludeDotsEl = class extends InterludeDotsBase {
  element = document.createElement("div");
  dot0 = document.createElement("span");
  dot1 = document.createElement("span");
  dot2 = document.createElement("span");
  lastStyle = "";
  constructor() {
    super();
    this.element.className = lyric_player_module_default.interludeDots;
    this.element.appendChild(this.dot0);
    this.element.appendChild(this.dot1);
    this.element.appendChild(this.dot2);
    this.element.style.opacity = "0";
  }
  getElement() {
    return this.element;
  }
  render(snapshot, left, top) {
    const curStyle = `transform:translate(${left.toFixed(2)}px, ${top.toFixed(2)}px) scale(${snapshot.scale.toFixed(4)});opacity:${snapshot.opacity.toFixed(3)}`;
    this.dot0.style.opacity = snapshot.dotOpacities[0].toFixed(3);
    this.dot1.style.opacity = snapshot.dotOpacities[1].toFixed(3);
    this.dot2.style.opacity = snapshot.dotOpacities[2].toFixed(3);
    if (this.lastStyle !== curStyle) {
      this.element.setAttribute("style", curStyle);
      this.lastStyle = curStyle;
    }
  }
  dispose() {
    super.dispose();
    this.element.remove();
  }
};
var LyricLineGroupBase = class {
  mainLine;
  bgLine;
  posY = new Spring(0);
  bgSlideY = new Spring(-80);
  top = 0;
  delay = Duration.ZERO;
  isActive = false;
  opacity = 1;
  blur = 0;
  isBgFirst = false;
  isUiDirty = true;
  constructor(mainLine, bgLine) {
    this.mainLine = mainLine;
    this.bgLine = bgLine;
  }
  get startTime() {
    return MediaTime.fromMillis(this.mainLine.getLine().startTime);
  }
  get endTime() {
    return MediaTime.fromMillis(this.mainLine.getLine().endTime);
  }
  onLineSizeChange(size) {
    this.mainLine.onLineSizeChange(size);
    this.bgLine?.onLineSizeChange(size);
  }
  setTransform(top, immediate, delay, isActive, opacity, blur) {
    this.top = top;
    this.delay = delay;
    this.isActive = isActive;
    this.opacity = opacity;
    this.blur = blur;
    this.setLineTransformations(delay);
    const enableSpring = this.lyricPlayer.getEnableSpring();
    const hiddenSlideY = (this.lyricPlayer.getAlwaysPostpositionBackground() ? false : this.isBgFirst) ? 80 : -80;
    const isPlaying = this.lyricPlayer.getIsPlaying();
    const targetBgSlideY = isActive || !isPlaying ? 0 : hiddenSlideY;
    if (immediate || !enableSpring) {
      this.posY.setPosition(top);
      this.bgSlideY.setPosition(targetBgSlideY);
    } else {
      this.posY.setTargetPosition(top, delay);
      this.bgSlideY.setTargetPosition(targetBgSlideY, delay);
    }
    this.isUiDirty = true;
  }
  setLineTransformations(delay) {
    const enableScale = this.lyricPlayer.getEnableScale();
    const isPlaying = this.lyricPlayer.getIsPlaying();
    const renderMode = this.isActive ? LyricLineRenderMode.GRADIENT : LyricLineRenderMode.SOLID;
    const SCALE_ASPECT = enableScale ? 97 : 100;
    let mainScale = 100;
    if (!this.isActive && isPlaying) mainScale = SCALE_ASPECT;
    this.mainLine.setTransform(mainScale, 1, 0, delay, renderMode);
    let bgScale = 100;
    if (!this.isActive && isPlaying) bgScale = 75;
    this.bgLine?.setTransform(bgScale, 1, 0, delay, renderMode);
  }
  update(delta = Duration.ZERO) {
    if (this.lyricPlayer.getEnableSpring()) {
      const posMoving = !this.posY.arrived();
      const bgMoving = !this.bgSlideY.arrived();
      this.posY.update(delta);
      this.bgSlideY.update(delta);
      if (posMoving || bgMoving) this.isUiDirty = true;
    }
    this.mainLine.update(delta);
    this.bgLine?.update(delta);
  }
  commitChanges() {
    if (!this.isInRenderRange()) return;
    if (this.isUiDirty) {
      this.renderStyles();
      this.isUiDirty = false;
    }
    this.mainLine.commitChanges();
    this.bgLine?.commitChanges();
  }
  rebuildAllLines() {
    this.mainLine.rebuildElement();
    this.bgLine?.rebuildElement();
  }
  enable(time, shouldPlay) {
    this.mainLine.enable(time, shouldPlay);
    this.bgLine?.enable(time, shouldPlay);
  }
  disable() {
    this.mainLine.disable();
    this.bgLine?.disable();
  }
  dispose() {
    this.mainLine.dispose();
    this.bgLine?.dispose();
  }
};
var LyricLineGroup = class extends LyricLineGroupBase {
  lyricPlayer;
  element;
  bgWrapper;
  lastIsActive;
  lastBgHeight = 0;
  lastBgIsHidden;
  lastYNum = -9999;
  lastOpacityNum = -1;
  lastBlurNum = -1;
  lastBgSlideYNum = -9999;
  constructor(lyricPlayer, mainLine) {
    super(mainLine);
    this.lyricPlayer = lyricPlayer;
    this.element = document.createElement("div");
    this.element.className = lyric_player_module_default.lyricLineWrapper;
    if (mainLine.getLine().isDuet) this.element.classList.add(lyric_player_module_default.isDuetWrapper);
    this.element.appendChild(mainLine.getElement());
    this.posY.setPosition(window.innerHeight * 2);
    lyricPlayer.resizeObserver.observe(this.element);
  }
  getElement() {
    return this.element;
  }
  isInRenderRange(includeOverscan = true) {
    const top = this.posY.getCurrentPosition();
    const index = this.lyricPlayer.currentLyricGroups.indexOf(this);
    const height = index !== -1 ? this.lyricPlayer.getLineHeight(index) : this.lyricPlayer.defaultLineHeight;
    const viewportHeight = this.lyricPlayer.size[1];
    if (viewportHeight <= 0 || height <= 0) return false;
    const overscan = includeOverscan ? this.lyricPlayer.getOverscanPx() : 0;
    return top < viewportHeight + overscan && top + height > -overscan;
  }
  show() {
    if (!this.element.parentElement) {
      const playerEl = this.lyricPlayer.getElement();
      const groups = this.lyricPlayer.currentLyricGroups;
      const myIndex = groups.indexOf(this);
      let referenceNode = null;
      if (myIndex !== -1) {
        for (let i = myIndex + 1; i < groups.length; i++) if (groups[i].element.parentElement === playerEl) {
          referenceNode = groups[i].element;
          break;
        }
      }
      playerEl.insertBefore(this.element, referenceNode);
      this.lyricPlayer.resizeObserver.observe(this.element);
      if (this.bgWrapper) this.lyricPlayer.resizeObserver.observe(this.bgWrapper);
    }
    this.mainLine.show();
    this.bgLine?.show();
  }
  hide() {
    if (this.element.parentElement) {
      this.lyricPlayer.resizeObserver.unobserve(this.element);
      if (this.bgWrapper) this.lyricPlayer.resizeObserver.unobserve(this.bgWrapper);
      this.element.remove();
    }
  }
  update(delta = Duration.ZERO) {
    super.update(delta);
  }
  commitChanges() {
    if (this.isInRenderRange()) {
      this.show();
      super.commitChanges();
    } else this.hide();
  }
  onBgSizeChange(size) {
    if (this.bgWrapper && this.lastBgHeight !== size[1]) {
      this.lastBgHeight = size[1];
      this.lastBgSlideYNum = -9999;
      this.isUiDirty = true;
    }
  }
  addBgLine(bgLine) {
    if (this.bgLine) this.bgLine.dispose();
    if (this.bgWrapper) this.bgWrapper.remove();
    this.bgLine = bgLine;
    const bgStartTime = bgLine.getLine().words[0]?.startTime ?? bgLine.getLine().startTime;
    const mainStartTime = this.mainLine.getLine().words[0]?.startTime ?? this.mainLine.getLine().startTime;
    this.isBgFirst = bgStartTime < mainStartTime;
    if (this.mainLine.getLine().isDuet) {
      bgLine.getElement().classList.add(lyric_player_module_default.lyricDuetLine);
      this.element.classList.add(lyric_player_module_default.isDuetWrapper);
    }
    this.bgWrapper = document.createElement("div");
    this.bgWrapper.className = lyric_player_module_default.bgWrapper;
    this.bgWrapper.appendChild(bgLine.getElement());
    if (!this.lyricPlayer.getAlwaysPostpositionBackground() && this.isBgFirst) {
      this.bgWrapper.classList.add(lyric_player_module_default.bgWrapperTop);
      this.element.insertBefore(this.bgWrapper, this.mainLine.getElement());
      this.bgSlideY.setPosition(80);
    } else this.element.appendChild(this.bgWrapper);
    this.lyricPlayer.lyricGroupElementMap.set(this.bgWrapper, this);
    if (this.element.parentElement) this.lyricPlayer.resizeObserver.observe(this.bgWrapper);
    this.lastBgHeight = this.bgWrapper.clientHeight || 0;
  }
  renderStyles() {
    const style = this.element.style;
    const currentY = this.posY.getCurrentPosition();
    if (Math.abs(currentY - this.lastYNum) >= 1e-3) {
      this.lastYNum = currentY;
      style.transform = `translateY(${currentY.toFixed(1)}px)`;
    }
    if (Math.abs(this.opacity - this.lastOpacityNum) >= 0.05) {
      this.lastOpacityNum = this.opacity;
      style.opacity = String(this.opacity);
    }
    const blurVal = Math.min(5, this.blur);
    if (Math.abs(blurVal - this.lastBlurNum) >= 0.05) {
      this.lastBlurNum = blurVal;
      style.filter = blurVal > 0.01 ? `blur(${blurVal.toFixed(2)}px)` : "none";
    }
    if (this.bgWrapper) {
      if (this.lastIsActive !== this.isActive) {
        this.lastIsActive = this.isActive;
        this.bgWrapper.classList.toggle(lyric_player_module_default.bgWrapperActive, this.isActive);
      }
      const bgStyle = this.bgWrapper.style;
      const slideY = this.bgSlideY.getCurrentPosition();
      if (Math.abs(slideY - this.lastBgSlideYNum) >= 1e-3) {
        this.lastBgSlideYNum = slideY;
        const activeProgress = clamp01(1 - Math.abs(slideY) / 80);
        const scaleStr = (0.8 + activeProgress * 0.2).toFixed(3);
        const shouldBgFirst = !this.lyricPlayer.getAlwaysPostpositionBackground() && this.isBgFirst;
        const translateYPx = slideY / 100 * this.lastBgHeight;
        if (shouldBgFirst) bgStyle.marginTop = `${(-this.lastBgHeight * (1 - activeProgress)).toFixed(1)}px`;
        else bgStyle.marginTop = "";
        bgStyle.transform = `translateY(${translateYPx.toFixed(1)}px) scale(${scaleStr})`;
        const isHidden = Math.abs(slideY - (shouldBgFirst ? 80 : -80)) < 0.1 && !this.isActive;
        if (this.lastBgIsHidden !== isHidden) {
          this.lastBgIsHidden = isHidden;
          this.bgWrapper.classList.toggle(lyric_player_module_default.bgWrapperHidden, isHidden);
        }
      }
    }
  }
  dispose() {
    super.dispose();
    this.lyricPlayer.resizeObserver.unobserve(this.element);
    if (this.bgWrapper) {
      this.lyricPlayer.lyricGroupElementMap.delete(this.bgWrapper);
      this.lyricPlayer.resizeObserver.unobserve(this.bgWrapper);
    }
    this.element.remove();
  }
};
var isCJK = (char) => {
  return /^[\p{Unified_Ideograph}\u0800-\u9FFC]+$/u.test(char);
};
var LyricLineBase = class extends EventTarget {
  top = 0;
  scale = 1;
  blur = 0;
  opacity = 1;
  delay = Duration.ZERO;
  isUiDirty = true;
  lineTransforms = { scale: new Spring(100) };
  /**
  * 用于 CJK 词语边界检测的分词器
  */
  static wordSegmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(void 0, { granularity: "word" }) : null;
  /**
  * Unicode 标准的全局 Grapheme Cluster 分词器
  * 用于正确处理 emoji、复合字符等
  */
  static graphemeSegmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;
  setTransform(scale = this.scale, opacity = this.opacity, blur = this.blur, delay = Duration.ZERO, _mode = LyricLineRenderMode.SOLID) {
    this.scale = scale;
    this.opacity = opacity;
    this.blur = blur;
    this.delay = delay;
    this.isUiDirty = true;
  }
  rebuildElement() {
  }
  /**
  * 判定歌词是否可以应用强调辉光效果
  *
  * 果子在对辉光效果的解释是一种强调（emphasized）效果
  *
  * 条件是一个单词时长大于等于 1s 且长度小于等于 7
  *
  * @param word 单词
  * @returns 是否可以应用强调辉光效果
  */
  static shouldEmphasize(word) {
    if (isCJK(word.word)) return word.endTime - word.startTime >= 1e3;
    return word.endTime - word.startTime >= 1e3 && word.word.trim().length <= 7 && word.word.trim().length > 1;
  }
  dispose() {
  }
};
var OVERFLOW_PENALTY_MULTIPLIER = 1e3;
var CJK_BREAK_PENALTY_RATIO = 0.15;
var NORMAL_BREAK_PENALTY_RATIO = 0.5;
var SPACE_BREAK_REWARD_RATIO = 0.4;
var PUNCTUATION_BREAK_REWARD_RATIO = 0.6;
var PUNCTUATION_REGEX = /[,.;:!?，。；：！？、）】》」』’”)[\]}>~…]$/;
function calcBalancedBreaks(children, containerWidth, fullText, segmenter) {
  const n = children.length;
  if (n === 0 || containerWidth <= 0) return [];
  const cjkBoundaries = /* @__PURE__ */ new Set();
  let offset = 0;
  for (const { segment, isWordLike } of segmenter.segment(fullText)) {
    if (offset > 0 && isWordLike) {
      if ([...segment].some((ch) => isCJK(ch))) cjkBoundaries.add(offset);
    }
    offset += segment.length;
  }
  const charOffsets = new Int32Array(n + 1);
  const prefixWidth = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    charOffsets[i + 1] = charOffsets[i] + children[i].text.length;
    prefixWidth[i + 1] = prefixWidth[i] + children[i].width;
  }
  if (prefixWidth[n] <= containerWidth) return [];
  const dp = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const nextBreak = new Int32Array(n + 1).fill(-1);
  dp[n] = 0;
  const PENALTY_CJK = (containerWidth * CJK_BREAK_PENALTY_RATIO) ** 2;
  const PENALTY_NORMAL = (containerWidth * NORMAL_BREAK_PENALTY_RATIO) ** 2;
  for (let i = n - 1; i >= 0; i--) for (let j = i + 1; j <= n; j++) {
    const w = prefixWidth[j] - prefixWidth[i];
    let lineCost = 0;
    if (w > containerWidth) {
      if (j === i + 1) lineCost = (w - containerWidth) ** 2 * OVERFLOW_PENALTY_MULTIPLIER;
      else continue;
    } else lineCost = (containerWidth - w) ** 2;
    let breakPenalty = 0;
    if (j < n) {
      const prevChild = children[j - 1];
      if (PUNCTUATION_REGEX.test(prevChild.text)) breakPenalty = -((containerWidth * PUNCTUATION_BREAK_REWARD_RATIO) ** 2);
      else if (prevChild.isSpace) breakPenalty = -((containerWidth * SPACE_BREAK_REWARD_RATIO) ** 2);
      else if (cjkBoundaries.has(charOffsets[j])) breakPenalty = PENALTY_CJK;
      else breakPenalty = PENALTY_NORMAL;
    }
    const totalCost = lineCost + breakPenalty + dp[j];
    if (totalCost < dp[i]) {
      dp[i] = totalCost;
      nextBreak[i] = j;
    }
  }
  const breaks = [];
  let curr = 0;
  while (curr < n) {
    curr = nextBreak[curr];
    if (curr > 0 && curr < n) breaks.push(curr);
  }
  return breaks;
}
var sharedCanvasCtx = null;
function getMeasurementContext() {
  if (!sharedCanvasCtx) sharedCanvasCtx = document.createElement("canvas").getContext("2d");
  return sharedCanvasCtx;
}
var LineBalancer = class {
  mainElement;
  isBalancing = false;
  lastBalancedContainerWidth = -1;
  constructor(mainElement) {
    this.mainElement = mainElement;
  }
  balanceLineBreaks(isNonDynamic, hasSplittedWords, wordSegmenter) {
    if (this.isBalancing || !this.mainElement) return;
    const computedStyle = getComputedStyle(this.mainElement);
    const paddingLeft = Number.parseFloat(computedStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(computedStyle.paddingRight) || 0;
    const containerWidth = this.mainElement.clientWidth - paddingLeft - paddingRight;
    if (containerWidth <= 0) return;
    if (isNonDynamic) {
      this.balanceNonDynamicLineBreaks(containerWidth, computedStyle, wordSegmenter);
      return;
    }
    if (!hasSplittedWords) return;
    this.balanceDynamicLineBreaks(containerWidth, wordSegmenter);
  }
  reset() {
    this.lastBalancedContainerWidth = -1;
  }
  executeLineBalance(containerWidth, adapter, wordSegmenter) {
    const existingBrs = this.mainElement.querySelectorAll("br");
    if (containerWidth === this.lastBalancedContainerWidth && existingBrs.length > 0) return;
    adapter.resetDOM();
    const prevWhiteSpace = this.mainElement.style.whiteSpace;
    this.mainElement.style.whiteSpace = "nowrap";
    const parentElement = this.mainElement.parentElement;
    let prevTransform = "";
    let transformChanged = false;
    if (parentElement) {
      prevTransform = parentElement.style.transform;
      if (prevTransform && prevTransform !== "none") {
        parentElement.style.transform = "none";
        transformChanged = true;
      }
    }
    let lockAcquired = false;
    try {
      const { childInfos, fullText } = adapter.buildChildInfos();
      let layoutWidth = childInfos.reduce((sum, c) => sum + c.width, 0);
      if (adapter.needsCalibration) {
        const range = document.createRange();
        range.selectNodeContents(this.mainElement);
        const visualWidth = range.getBoundingClientRect().width;
        if (layoutWidth > 0 && visualWidth > 0) {
          const scale = visualWidth / layoutWidth;
          for (const info of childInfos) info.width *= scale;
        }
        layoutWidth = visualWidth;
      }
      const safeContainerWidth = Math.max(1, containerWidth);
      if (layoutWidth <= safeContainerWidth) {
        this.lastBalancedContainerWidth = containerWidth;
        return;
      }
      const breaks = calcBalancedBreaks(childInfos, safeContainerWidth, fullText, wordSegmenter);
      if (breaks.length === 0) {
        this.lastBalancedContainerWidth = containerWidth;
        return;
      }
      this.isBalancing = true;
      lockAcquired = true;
      adapter.applyBreaks(breaks, childInfos);
      this.lastBalancedContainerWidth = containerWidth;
      this.isBalancing = false;
    } finally {
      this.mainElement.style.whiteSpace = prevWhiteSpace;
      if (transformChanged && parentElement) parentElement.style.transform = prevTransform;
      if (lockAcquired) this.isBalancing = false;
    }
  }
  balanceDynamicLineBreaks(containerWidth, wordSegmenter) {
    const infoToNode = [];
    this.executeLineBalance(containerWidth, {
      resetDOM: () => {
        this.mainElement.querySelectorAll("br").forEach((br) => {
          br.remove();
        });
      },
      buildChildInfos: () => {
        infoToNode.length = 0;
        const childNodes = Array.from(this.mainElement.childNodes);
        const childInfos = [];
        const range = document.createRange();
        for (const node of childNodes) if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? "";
          if (text.length === 0) continue;
          range.selectNodeContents(node);
          childInfos.push({
            width: range.getBoundingClientRect().width,
            text,
            isSpace: text.trim().length === 0
          });
          infoToNode.push(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node;
          const rect = el.getBoundingClientRect();
          const elStyle = getComputedStyle(el);
          const marginLeft = Number.parseFloat(elStyle.marginLeft) || 0;
          const marginRight = Number.parseFloat(elStyle.marginRight) || 0;
          childInfos.push({
            width: clampPositive(rect.width + marginLeft + marginRight),
            text: el.textContent ?? "",
            isSpace: false
          });
          infoToNode.push(node);
        }
        return {
          childInfos,
          fullText: childInfos.map((c) => c.text).join("")
        };
      },
      applyBreaks: (breaks) => {
        for (let i = breaks.length - 1; i >= 0; i--) {
          const breakIndex = breaks[i];
          if (breakIndex >= 0 && breakIndex < infoToNode.length) this.mainElement.insertBefore(document.createElement("br"), infoToNode[breakIndex]);
        }
      },
      needsCalibration: false
    }, wordSegmenter);
  }
  balanceNonDynamicLineBreaks(containerWidth, computedStyle, wordSegmenter) {
    const fullText = this.mainElement.textContent ?? "";
    if (fullText.trim().length === 0) return;
    this.executeLineBalance(containerWidth, {
      resetDOM: () => {
        this.mainElement.replaceChildren(); // Aurora patch: innerHTML="" trips YouTube's Trusted Types CSP
        this.mainElement.textContent = fullText;
      },
      buildChildInfos: () => {
        const ctx = getMeasurementContext();
        if (!ctx) {
          console.debug("Canvas 2D context is not supported, skipping line balancing");
          return {
            childInfos: [],
            fullText
          };
        }
        ctx.font = `${computedStyle.fontWeight} ${computedStyle.fontSize} ${computedStyle.fontFamily}`;
        if ("letterSpacing" in ctx) ctx.letterSpacing = computedStyle.letterSpacing !== "normal" ? computedStyle.letterSpacing : "0px";
        if ("wordSpacing" in ctx) ctx.wordSpacing = computedStyle.wordSpacing !== "normal" ? computedStyle.wordSpacing : "0px";
        const childInfos = [];
        for (const { segment } of wordSegmenter.segment(fullText)) childInfos.push({
          width: ctx.measureText(segment).width,
          text: segment,
          isSpace: segment.trim().length === 0
        });
        return {
          childInfos,
          fullText
        };
      },
      applyBreaks: (breaks, childInfos) => {
        this.mainElement.replaceChildren(); // Aurora patch: Trusted Types
        const breakSet = new Set(breaks);
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < childInfos.length; i++) {
          if (breakSet.has(i)) fragment.appendChild(document.createElement("br"));
          fragment.appendChild(document.createTextNode(childInfos[i].text));
        }
        this.mainElement.appendChild(fragment);
      },
      needsCalibration: true
    }, wordSegmenter);
  }
};
var SPLIT_WHITESPACE_RE = /(\s+)/;
var WHITESPACE_RE = /\s/g;
function chunkAndSplitLyricWords(words) {
  const result = [];
  let currentGroup = [];
  const flushGroup = () => {
    if (currentGroup.length > 0) {
      result.push(currentGroup.length === 1 ? currentGroup[0] : [...currentGroup]);
      currentGroup = [];
    }
  };
  const processAtom = (atom) => {
    const isSpace = atom.word.trim().length === 0;
    const hasRuby = (atom.ruby?.length ?? 0) > 0;
    const isCJKChar = isCJK(atom.word);
    if (!isSpace && !hasRuby && !isCJKChar) currentGroup.push(atom);
    else {
      flushGroup();
      result.push(atom);
    }
  };
  for (const w of words) {
    const content = w.word.trim();
    const isSpace = content.length === 0;
    const romanWord = w.romanWord ?? "";
    const obscene = w.obscene ?? false;
    const hasRuby = (w.ruby?.length ?? 0) > 0;
    if (isSpace) {
      processAtom({
        ...w,
        obscene
      });
      continue;
    }
    if (hasRuby) {
      const leadingSpaceMatch = w.word.match(/^\s+/);
      const trailingSpaceMatch = w.word.match(/\s+$/);
      const leadingSpace = leadingSpaceMatch ? leadingSpaceMatch[0] : "";
      const trailingSpace = trailingSpaceMatch ? trailingSpaceMatch[0] : "";
      if (leadingSpace) processAtom({
        word: leadingSpace,
        romanWord: "",
        startTime: w.startTime,
        endTime: w.startTime,
        obscene
      });
      processAtom({
        ...w,
        word: content,
        obscene
      });
      if (trailingSpace) processAtom({
        word: trailingSpace,
        romanWord: "",
        startTime: w.endTime,
        endTime: w.endTime,
        obscene
      });
      continue;
    }
    const parts = w.word.split(SPLIT_WHITESPACE_RE).filter((p2) => p2.length > 0);
    const totalLength = w.word.replace(WHITESPACE_RE, "").length || 1;
    const timePerUnit = (w.endTime - w.startTime) / totalLength;
    const wordParts = w.word.trim().split(/\s+/).filter((p2) => p2.length > 0);
    const romanTrimmed = romanWord.trim();
    const romanParts = romanTrimmed.length > 0 ? romanTrimmed.split(/\s+/).filter((p2) => p2.length > 0) : [];
    const isMatched = wordParts.length > 0 && wordParts.length === romanParts.length;
    let currentOffset = 0;
    let nonSpaceIndex = 0;
    for (const part of parts) {
      if (!part.trim()) {
        const startTime = w.startTime + currentOffset * timePerUnit;
        processAtom({
          word: part,
          romanWord: "",
          startTime,
          endTime: startTime,
          obscene
        });
        continue;
      }
      let partRomanWord = "";
      if (romanParts.length > 0) {
        if (isMatched) partRomanWord = romanParts[nonSpaceIndex] ?? "";
        else if (nonSpaceIndex === 0) partRomanWord = romanWord;
      }
      nonSpaceIndex++;
      if (isCJK(part) && part.length > 1 && romanTrimmed.length === 0) {
        const chars = part.split("");
        for (const char of chars) {
          const startTime = w.startTime + currentOffset * timePerUnit;
          processAtom({
            word: char,
            romanWord: "",
            startTime,
            endTime: startTime + timePerUnit,
            obscene
          });
          currentOffset += 1;
        }
      } else {
        const partRealLen = part.length;
        const startTime = w.startTime + currentOffset * timePerUnit;
        const duration = partRealLen * timePerUnit;
        processAtom({
          word: part,
          romanWord: partRomanWord,
          startTime,
          endTime: startTime + duration,
          obscene
        });
        currentOffset += partRealLen;
      }
    }
  }
  flushGroup();
  return result;
}
function createMatrix4() {
  return [
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1
  ];
}
function scaleMatrix4(m, scale = 1, origin = {
  x: 0,
  y: 0
}) {
  const [ox, oy] = [origin.x, origin.y];
  return [
    m[0] * scale,
    m[1] * scale,
    m[2] * scale,
    m[3],
    m[4] * scale,
    m[5] * scale,
    m[6] * scale,
    m[7],
    m[8] * scale,
    m[9] * scale,
    m[10] * scale,
    m[11],
    m[12] - ox * scale + ox,
    m[13] - oy * scale + oy,
    m[14],
    m[15]
  ];
}
function matrix4ToCSS(m, fractionDigits = 4) {
  const format = (n, _) => n.toFixed(fractionDigits);
  return `matrix3d(${m.map(format).join(", ")})`;
}
// Aurora patch: 32 -> 12. Each emphasised character gets a glow AND a float
// animation, each built from this many keyframes, so a 7-character word was
// generating 7 * 2 * 32 = 448 keyframes. That is the dominant per-frame cost on
// word-by-word lyrics and it scales with how many long words a song has, which
// is why some parts of a track felt like 20fps and others 50. The easing is a
// smooth bezier, so 12 samples are visually indistinguishable.
var ANIMATION_FRAME_QUANTITY = 12;
var norNum = (min2, max2) => (x) => clamp01((x - min2) / (max2 - min2));
var EMP_EASING_MID = 0.5;
var beginNum = norNum(0, EMP_EASING_MID);
var endNum = norNum(EMP_EASING_MID, 1);
var bezIn = bezier(0.2, 0.4, 0.58, 1);
var bezOut = bezier(0.3, 0, 0.58, 1);
var makeEmpEasing = (mid) => {
  return (x) => x < mid ? bezIn(beginNum(x)) : 1 - bezOut(endNum(x));
};
var empEasing = makeEmpEasing(EMP_EASING_MID);
function createEmphasizeAnimation(options) {
  const params = calculateEmphasizeParams(options);
  const totalChars = options.characterElements.length;
  const result = [];
  options.characterElements.forEach((el, i) => {
    const wordDe = params.de + params.du / 2.5 / params.anchorCharCount * i;
    result.push(createCharGlowAnimation(el, i, totalChars, wordDe, params));
    result.push(createCharFloatAnimation(el, wordDe, options.isBG, params));
  });
  return result;
}
function calculateEmphasizeParams(options) {
  const { duration, delay, rubyCharCount, characterElements, isLastWord } = options;
  const de = clampPositive(delay);
  let du = Math.max(1e3, duration);
  const anchorCharCount = rubyCharCount > 0 ? rubyCharCount : Math.max(1, characterElements.length);
  let amount = du / 2e3;
  amount = amount > 1 ? Math.sqrt(amount) : amount ** 3;
  let blur = du / 3e3;
  blur = blur > 1 ? Math.sqrt(blur) : blur ** 3;
  amount *= 0.6;
  blur *= 0.5;
  if (isLastWord) {
    amount *= 1.6;
    blur *= 1.5;
    du *= 1.2;
  }
  amount = Math.min(1.2, amount);
  blur = Math.min(0.8, blur);
  return {
    amount,
    blur,
    du,
    de,
    anchorCharCount,
    animateDu: Number.isFinite(du) ? du : 0
  };
}
function generateGlowKeyframes(charIndex, totalChars, amount, blur) {
  return new Array(ANIMATION_FRAME_QUANTITY).fill(0).map((_, j) => {
    const x = (j + 1) / ANIMATION_FRAME_QUANTITY;
    const transX = empEasing(x);
    const glowLevel = transX * blur;
    const mat = scaleMatrix4(createMatrix4(), 1 + transX * 0.1 * amount);
    const offsetX = -transX * 0.03 * amount * (totalChars / 2 - charIndex);
    const offsetY = -transX * 0.025 * amount;
    return {
      offset: x,
      transform: `${matrix4ToCSS(mat, 4)} translate(${offsetX}em, ${offsetY}em)`,
      textShadow: `0 0 ${Math.min(0.3, blur * 0.3)}em rgba(255, 255, 255, ${glowLevel})`
    };
  });
}
function generateFloatKeyframes(isBG) {
  return new Array(ANIMATION_FRAME_QUANTITY).fill(0).map((_, j) => {
    const x = (j + 1) / ANIMATION_FRAME_QUANTITY;
    let y = Math.sin(x * Math.PI);
    if (isBG) y *= 2;
    return {
      offset: x,
      transform: `translateY(${-y * 0.05}em)`
    };
  });
}
function createCharGlowAnimation(el, charIndex, totalChars, wordDelay, params) {
  const frames = generateGlowKeyframes(charIndex, totalChars, params.amount, params.blur);
  const glow = el.animate(frames, {
    duration: params.animateDu,
    delay: Number.isFinite(wordDelay) ? wordDelay : 0,
    id: `emphasize-word-${el.textContent}-${charIndex}`,
    iterations: 1,
    composite: "replace",
    fill: "both"
  });
  glow.onfinish = () => glow.pause();
  glow.pause();
  return glow;
}
function createCharFloatAnimation(el, wordDelay, isBG, params) {
  const frames = generateFloatKeyframes(isBG);
  const float = el.animate(frames, {
    duration: params.animateDu * 1.4,
    delay: Number.isFinite(wordDelay) ? wordDelay - 400 : 0,
    id: "emphasize-word-float",
    iterations: 1,
    composite: "add",
    fill: "both"
  });
  float.onfinish = () => float.pause();
  float.pause();
  return float;
}
function createFloatAnimation(wordEl, options) {
  const { word, lineStartTime, isBG } = options;
  const delay = word.startTime - lineStartTime;
  const duration = Math.max(1e3, word.endTime - word.startTime);
  let up = 0.05;
  if (isBG) up *= 2;
  const a = wordEl.animate([{ transform: "translateY(0px)" }, { transform: `translateY(${-up}em)` }], {
    duration: Number.isFinite(duration) ? duration : 0,
    delay: Number.isFinite(delay) ? delay : 0,
    id: "float-word",
    composite: "add",
    fill: "both",
    easing: "ease-out"
  });
  a.pause();
  return a;
}
var bright = "rgb(0 0 0 / var(--bright-mask-alpha, 1))";
var dark = "rgb(0 0 0 / var(--dark-mask-alpha, 1))";
function generateFadeGradient(width) {
  const totalAspect = 2 + width;
  const halfFadePercent = width / totalAspect * 50;
  const leftPercent = 50 - halfFadePercent;
  const rightPercent = 50 + halfFadePercent;
  return [`linear-gradient(to right, ${bright} ${leftPercent}%, ${dark} ${rightPercent}%)`, totalAspect];
}
var CalcMaskAnimator = class {
  words;
  context;
  constructor(words, context) {
    this.words = words;
    this.context = context;
  }
  apply() {
    for (const word of this.words) {
      const { mainElement: wordEl, width: textWidth, padding: paddingLeft, height, startTime, endTime } = word;
      const totalWordWidth = textWidth + paddingLeft * 2;
      const fadeWidth = height * this.context.wordFadeWidth;
      const [maskImage, totalAspect] = generateFadeGradient(fadeWidth / totalWordWidth);
      const totalAspectStr = `${totalAspect * 100}% 100%`;
      const speed = textWidth / Math.max(Math.abs(endTime - startTime), 1);
      const startPos = paddingLeft - totalWordWidth - fadeWidth / 2;
      // Aurora patch: default of 0. The host scopes --amll-player-time to the
      // ACTIVE line only (see amllDrive in 22-amll-integration), so lines that
      // are not currently playing must resolve to a sane "not yet sung" state
      // rather than invalidating the whole declaration.
      const maskPos = `clamp(${-totalWordWidth - fadeWidth}px, ${startPos}px + (var(--amll-player-time, 0) - ${startTime}) * ${speed}px, 0px) 0px`;
      Object.assign(wordEl.style, {
        maskImage,
        webkitMaskImage: maskImage,
        maskRepeat: "no-repeat",
        webkitMaskRepeat: "no-repeat",
        maskSize: totalAspectStr,
        webkitMaskSize: totalAspectStr,
        maskPosition: maskPos,
        webkitMaskPosition: maskPos
      });
    }
  }
  setCurrentTime(_timeRelative, _isPlaying) {
  }
  pause() {
  }
  resume() {
  }
  dispose() {
    for (const word of this.words) {
      const wordEl = word.mainElement;
      if (wordEl) ["mask", "-webkit-mask"].forEach((prop) => {
        wordEl.style.removeProperty(prop);
      });
    }
  }
};
var WebMaskAnimator = class {
  words;
  context;
  animations = [];
  totalFadeDuration;
  constructor(words, context) {
    this.words = words;
    this.context = context;
    this.totalFadeDuration = this.context.lineEndTime - this.context.lineStartTime;
  }
  apply() {
    this.buildAnimations();
  }
  setCurrentTime(timeRelative, isPlaying) {
    const t = Math.min(this.totalFadeDuration, Math.max(0, timeRelative));
    for (const a of this.animations) {
      a.currentTime = t;
      a.playbackRate = 1;
      const endTime = this.getAnimationEndTime(a);
      if (isPlaying && t < endTime) a.play();
      else a.pause();
    }
  }
  pause() {
    for (const a of this.animations) a.pause();
  }
  resume() {
    for (const a of this.animations) {
      const endTime = this.getAnimationEndTime(a);
      const currentTime = Number(a.currentTime ?? 0);
      if (a.playState !== "finished" && currentTime < endTime) a.play();
    }
  }
  buildAnimations() {
    for (const [i, word] of this.words.entries()) {
      const wordEl = word.mainElement;
      if (!wordEl) continue;
      const fadeWidth = word.height * this.context.wordFadeWidth;
      this.updateWordMaskStyles(wordEl, word, fadeWidth);
      const frames = this.generateWordKeyframes(word, i, fadeWidth);
      try {
        const ani = wordEl.animate(frames, {
          duration: Math.max(this.totalFadeDuration, 1),
          id: `fade-word-${word.word}-${i}`,
          fill: "both"
        });
        ani.pause();
        this.animations.push(ani);
      } catch (err) {
        console.warn("\u5E94\u7528\u6E10\u53D8\u52A8\u753B\u53D1\u751F\u9519\u8BEF", frames, this.totalFadeDuration, err);
      }
    }
  }
  /**
  * 为单个单词 DOM 元素配置 CSS 渐变遮罩样式
  */
  updateWordMaskStyles(wordEl, word, fadeWidth) {
    const [maskImage, totalAspect] = generateFadeGradient(fadeWidth / (word.width + word.padding * 2));
    Object.assign(wordEl.style, {
      maskImage,
      maskRepeat: "no-repeat",
      maskSize: `${totalAspect * 100}% 100%`
    });
  }
  /**
  * 推导时间轴并生成单个单词在播放周期内的所有遮罩关键帧
  */
  generateWordKeyframes(targetWord, targetIndex, fadeWidth) {
    const widthBeforeSelf = this.words.slice(0, targetIndex).reduce((a, b) => a + b.width, 0) + (this.words[0] ? fadeWidth : 0);
    const minOffset = -(targetWord.width + targetWord.padding * 2 + fadeWidth);
    const initialPos = -widthBeforeSelf - targetWord.width - targetWord.padding - fadeWidth;
    const config = {
      minOffset,
      fadeWidth
    };
    const cursor = {
      curPos: initialPos,
      lastPos: initialPos,
      timeOffset: 0,
      lastTime: 0,
      lastTimeStamp: 0,
      frames: []
    };
    this.pushClampedKeyframe(cursor, config.minOffset);
    for (const [j, otherWord] of this.words.entries()) {
      this.advancePauseTimeline(cursor, otherWord.startTime, config);
      const rubySegments = otherWord.ruby?.filter((r) => Boolean(r?.word?.trim())) ?? [];
      if (rubySegments.length > 0) this.advanceRubyWordTimeline(cursor, otherWord, rubySegments, config, j);
      else this.advancePlainWordTimeline(cursor, otherWord, config, j);
    }
    return cursor.frames;
  }
  advancePauseTimeline(cursor, targetStartTime, config) {
    const curTimeStamp = targetStartTime - this.context.lineStartTime;
    const staticDuration = curTimeStamp - cursor.lastTimeStamp;
    if (staticDuration > 0) this.advanceTimelineStep(cursor, config, staticDuration, 0);
    cursor.lastTimeStamp = curTimeStamp;
  }
  /**
  * 推导带有 Ruby 注音的多音节单词时间线
  *
  * 原理是把每个主音节的总宽度均分给 ruby 片段总数，并应用每个 ruby 片段的时间给主音节
  *
  * 此功能具有诸多缺陷，如下所示：
  * 1. 汉字是一个紧凑的表意单位，内部由形旁、声旁或笔画构成，与读音之间不存在从左到右的序列关系，
  *    像是一个多音节英语单词按连字符分开时间轴和停顿这才有语义
  * 2. 在主音节中间分时间和停顿会导致用户必须将视线焦点从主音节上移到上方的 ruby
  *    注音，以寻找音节锚点，显然破坏用户预期
  * 3. ruby 的注音功能已由逐字音译承担
  *
  * 但考虑到功能已进入生产环境，因此保留此功能
  */
  advanceRubyWordTimeline(cursor, otherWord, rubySegments, config, wordIndex) {
    const rubyCharCount = rubySegments.reduce((sum, r) => sum + r.word.length, 0);
    const widthPerChar = otherWord.width / rubyCharCount;
    let charIndex = 0;
    for (const ruby of rubySegments) {
      const rubyStart = Math.max(ruby.startTime, otherWord.startTime);
      const rubyEnd = Math.min(Math.max(ruby.endTime, rubyStart), otherWord.endTime);
      const rubyStartStamp = rubyStart - this.context.lineStartTime;
      const rubyStaticDuration = rubyStartStamp - cursor.lastTimeStamp;
      if (rubyStaticDuration > 0) this.advanceTimelineStep(cursor, config, rubyStaticDuration, 0);
      cursor.lastTimeStamp = rubyStartStamp;
      const perCharDuration = Math.max(0, rubyEnd - rubyStart) / ruby.word.length;
      for (let i = 0; i < ruby.word.length; i++) {
        let movePx = widthPerChar;
        if (wordIndex === 0 && charIndex === 0) movePx += config.fadeWidth * 1.5;
        if (wordIndex === this.words.length - 1 && charIndex === rubyCharCount - 1) movePx += config.fadeWidth * 0.5;
        this.advanceTimelineStep(cursor, config, perCharDuration, movePx);
        cursor.lastTimeStamp += perCharDuration;
        charIndex++;
      }
    }
    const wordEndStamp = Math.max(otherWord.endTime - this.context.lineStartTime, cursor.lastTimeStamp);
    const wordTailDuration = wordEndStamp - cursor.lastTimeStamp;
    if (wordTailDuration > 0) this.advanceTimelineStep(cursor, config, wordTailDuration, 0);
    cursor.lastTimeStamp = wordEndStamp;
  }
  advancePlainWordTimeline(cursor, otherWord, config, wordIndex) {
    const { startTime, endTime, width } = otherWord;
    const fadeDuration = Math.max(0, endTime - startTime);
    let movePx = width;
    if (wordIndex === 0) movePx += config.fadeWidth * 1.5;
    if (wordIndex === this.words.length - 1) movePx += config.fadeWidth * 0.5;
    this.advanceTimelineStep(cursor, config, fadeDuration, movePx);
    cursor.lastTimeStamp += fadeDuration;
  }
  advanceTimelineStep(cursor, config, duration, movePx) {
    cursor.timeOffset += duration / this.totalFadeDuration;
    cursor.curPos += movePx;
    if (duration > 0) this.pushClampedKeyframe(cursor, config.minOffset);
  }
  pushClampedKeyframe(cursor, minOffset) {
    const moveOffset = cursor.curPos - cursor.lastPos;
    const time = Math.min(1, Math.max(0, cursor.timeOffset));
    const duration = time - cursor.lastTime;
    const msPerPixel = moveOffset !== 0 ? Math.abs(duration / moveOffset) : 0;
    if (cursor.curPos > minOffset && cursor.lastPos < minOffset) {
      const staticTime = Math.abs(cursor.lastPos - minOffset) * msPerPixel;
      cursor.frames.push({
        offset: cursor.lastTime + staticTime,
        maskPosition: `${Math.min(Math.max(cursor.lastPos, minOffset), 0)}px 0`
      });
    }
    if (cursor.curPos > 0 && cursor.lastPos < 0) {
      const staticTime = Math.abs(cursor.lastPos) * msPerPixel;
      cursor.frames.push({
        offset: cursor.lastTime + staticTime,
        maskPosition: `${Math.min(Math.max(cursor.curPos, minOffset), 0)}px 0`
      });
    }
    cursor.frames.push({
      offset: time,
      maskPosition: `${Math.min(Math.max(cursor.curPos, minOffset), 0)}px 0`
    });
    cursor.lastPos = cursor.curPos;
    cursor.lastTime = time;
  }
  getAnimationEndTime(animation) {
    const timing = animation.effect?.getComputedTiming();
    return Number(timing?.delay ?? 0) + Number(timing?.duration ?? 0);
  }
  dispose() {
    for (const a of this.animations) a.cancel();
    this.animations.length = 0;
    for (const word of this.words) {
      const wordEl = word.mainElement;
      if (wordEl) wordEl.style.removeProperty("mask");
    }
  }
};
function createLineMaskAnimator(words, context) {
  if (context.supportMaskImage) return new WebMaskAnimator(words, context);
  else return new CalcMaskAnimator(words, context);
}
var LyricLineEl = class extends LyricLineBase {
  lyricPlayer;
  lyricLine;
  element = document.createElement("div");
  splittedWords = [];
  built = false;
  renderMode = LyricLineRenderMode.SOLID;
  maskAnimator;
  lastScaleNum = -1;
  lineHasRubyWords;
  lineHasRomanWords;
  /**
  * 用于平衡换行、尽量减少各行长度差异的类
  */
  balancer;
  constructor(lyricPlayer, lyricLine = {
    words: [],
    translatedLyric: "",
    romanLyric: "",
    startTime: 0,
    endTime: 0,
    isBG: false,
    isDuet: false
  }) {
    super();
    this.lyricPlayer = lyricPlayer;
    this.lyricLine = lyricLine;
    this.lineHasRubyWords = this.lyricLine.words.some((word) => (word.ruby?.length ?? 0) > 0);
    this.lineHasRomanWords = this.lyricLine.words.some((word) => (word.romanWord?.trim().length ?? 0) > 0);
    this.element.setAttribute("class", lyric_player_module_default.lyricLine);
    if (this.lyricLine.isBG) this.element.classList.add(lyric_player_module_default.lyricBgLine);
    if (this.lyricLine.isDuet) this.element.classList.add(lyric_player_module_default.lyricDuetLine);
    this.element.appendChild(document.createElement("div"));
    this.element.appendChild(document.createElement("div"));
    this.element.appendChild(document.createElement("div"));
    const main = this.element.children[0];
    const trans = this.element.children[1];
    const roman = this.element.children[2];
    main.setAttribute("class", lyric_player_module_default.lyricMainLine);
    trans.setAttribute("class", lyric_player_module_default.lyricSubLine);
    roman.setAttribute("class", lyric_player_module_default.lyricSubLine);
    if (LyricLineBase.wordSegmenter) this.balancer = new LineBalancer(main);
    this.rebuildStyle();
  }
  isEnabled = false;
  async enable(maskAnimationTime = this.lyricPlayer.getCurrentTime(), shouldPlay = this.lyricPlayer.getIsPlaying()) {
    this.isEnabled = true;
    this.element.classList.add(lyric_player_module_default.active);
    const main = this.element.children[0];
    const relativeTime = clampPositive(maskAnimationTime - this.lyricLine.startTime);
    for (const word of this.splittedWords) for (const a of word.elementAnimations) {
      a.currentTime = relativeTime;
      a.playbackRate = 1;
      const timing = a.effect?.getComputedTiming();
      const endTime = Number(timing?.delay ?? 0) + Number(timing?.duration ?? 0);
      if (shouldPlay && relativeTime < endTime) a.play();
      else a.pause();
    }
    this.maskAnimator?.setCurrentTime(relativeTime, shouldPlay);
    main.classList.add(lyric_player_module_default.active);
  }
  disable() {
    this.isEnabled = false;
    this.element.classList.remove(lyric_player_module_default.active);
    this.setRenderMode(LyricLineRenderMode.SOLID);
    const main = this.element.children[0];
    for (const word of this.splittedWords) for (const a of word.elementAnimations) if (a.id === "float-word" || a.id.includes("emphasize-word-float-only")) {
      a.playbackRate = -1;
      a.play();
    }
    this.maskAnimator?.pause();
    main.classList.remove(lyric_player_module_default.active);
  }
  lastWord;
  async resume() {
    if (!this.isEnabled) return;
    for (const word of this.splittedWords) for (const a of word.elementAnimations) if (!this.lastWord || this.splittedWords.indexOf(this.lastWord) < this.splittedWords.indexOf(word)) {
      const timing = a.effect?.getComputedTiming();
      const endTime = Number(timing?.delay ?? 0) + Number(timing?.duration ?? 0);
      if (a.playState !== "finished" && (a.currentTime || 0) < endTime) a.play();
    }
    this.maskAnimator?.resume();
  }
  async pause() {
    if (!this.isEnabled) return;
    for (const word of this.splittedWords) for (const a of word.elementAnimations) a.pause();
    this.maskAnimator?.pause();
  }
  getLine() {
    return this.lyricLine;
  }
  show() {
    if (!this.built) {
      this.rebuildElement();
      this.built = true;
      this.updateMaskImageSync();
    }
  }
  rebuildStyle() {
    const style = this.element.style;
    const currentScale = this.lineTransforms.scale.getCurrentPosition() / 100;
    if (Math.abs(currentScale - this.lastScaleNum) >= 1e-4) {
      this.lastScaleNum = currentScale;
      style.transform = `scale(${currentScale.toFixed(3)})`;
    }
  }
  rebuildElement() {
    this.disposeElements();
    const main = this.element.children[0];
    const trans = this.element.children[1];
    const roman = this.element.children[2];
    if (this.lyricPlayer._getIsNonDynamic()) {
      main.textContent = this.lyricLine.words.map((w) => w.word).join("");
      this.setSubLinesText(trans, roman);
      return;
    }
    const chunkedWords = chunkAndSplitLyricWords(this.lyricLine.words);
    main.replaceChildren(); // Aurora patch: Trusted Types
    for (const chunk of chunkedWords) this.buildWord(chunk, main);
    this.setSubLinesText(trans, roman);
  }
  /** 设置翻译与音译行文本 */
  setSubLinesText(trans, roman) {
    trans.textContent = this.lyricLine.translatedLyric;
    roman.textContent = this.lyricLine.romanLyric;
  }
  getRubyCharCount(word) {
    return (word.ruby ?? []).reduce((total, ruby) => total + ruby.word.length, 0);
  }
  getRubySegments(word) {
    return (word.ruby ?? []).filter((ruby) => (ruby?.word?.trim().length ?? 0) > 0);
  }
  createWord(word, shouldEmphasize) {
    const mainWordEl = document.createElement("span");
    const subElements = [];
    const romanWord = word.romanWord?.trim() ?? "";
    const wordContainer = this.lineHasRubyWords ? document.createElement("span") : mainWordEl;
    const wordTextContainer = this.lineHasRubyWords ? document.createElement("span") : wordContainer;
    if (this.lineHasRubyWords) {
      const rubyWordEl = document.createElement("span");
      const rubySegments = this.getRubySegments(word);
      for (const ruby of rubySegments) {
        const rubyPartEl = document.createElement("span");
        rubyPartEl.textContent = ruby.word;
        rubyPartEl.dataset.startTime = String(ruby.startTime);
        rubyPartEl.dataset.endTime = String(ruby.endTime);
        rubyWordEl.appendChild(rubyPartEl);
      }
      rubyWordEl.classList.add(lyric_player_module_default.rubyWord);
      mainWordEl.classList.add(lyric_player_module_default.wordWithRuby);
      wordContainer.classList.add(lyric_player_module_default.wordBody);
      wordTextContainer.classList.add(lyric_player_module_default.rubyBaseWord);
      wordContainer.appendChild(wordTextContainer);
      mainWordEl.appendChild(rubyWordEl);
      mainWordEl.appendChild(wordContainer);
    }
    const displayWord = word.word;
    if (shouldEmphasize) {
      mainWordEl.classList.add(lyric_player_module_default.emphasize);
      const trimmedWord = displayWord.trim();
      if (LyricLineBase.graphemeSegmenter) for (const { segment } of LyricLineBase.graphemeSegmenter.segment(trimmedWord)) {
        const charEl = document.createElement("span");
        charEl.textContent = segment;
        subElements.push(charEl);
        wordTextContainer.appendChild(charEl);
      }
      else for (const segment of Array.from(trimmedWord)) {
        const charEl = document.createElement("span");
        charEl.textContent = segment;
        subElements.push(charEl);
        wordTextContainer.appendChild(charEl);
      }
    } else if (this.lineHasRomanWords) {
      const wordEl = document.createElement("span");
      wordEl.textContent = displayWord.trim();
      wordTextContainer.appendChild(wordEl);
    } else if (romanWord.length === 0) wordTextContainer.textContent = displayWord.trim();
    if (this.lineHasRomanWords) {
      const romanWordEl = document.createElement("span");
      romanWordEl.textContent = romanWord.length > 0 ? romanWord : "\xA0";
      romanWordEl.classList.add(lyric_player_module_default.romanWord);
      wordContainer.appendChild(romanWordEl);
    }
    return {
      ...word,
      mainElement: mainWordEl,
      subElements,
      elementAnimations: [createFloatAnimation(mainWordEl, {
        word,
        lineStartTime: this.lyricLine.startTime,
        isBG: this.lyricLine.isBG
      })],
      width: 0,
      height: 0,
      padding: 0,
      shouldEmphasize
    };
  }
  buildWord(input, main) {
    const chunk = Array.isArray(input) ? input : [input];
    if (chunk.length === 0) return;
    if (chunk.every((w) => !w.word.trim())) {
      const textContent = chunk.map((w) => w.word).join("");
      main.appendChild(document.createTextNode(textContent));
      return;
    }
    const merged = chunk.reduce((a, b) => {
      a.endTime = Math.max(a.endTime, b.endTime);
      a.startTime = Math.min(a.startTime, b.startTime);
      a.word += b.word;
      return a;
    }, {
      word: "",
      romanWord: "",
      startTime: Number.POSITIVE_INFINITY,
      endTime: Number.NEGATIVE_INFINITY,
      wordType: "normal",
      obscene: false
    });
    let emp = chunk.some((word) => LyricLineBase.shouldEmphasize(word));
    if (!isCJK(merged.word)) emp = emp || LyricLineBase.shouldEmphasize(merged);
    const wrapperWordEl = document.createElement("span");
    wrapperWordEl.classList.add(lyric_player_module_default.emphasizeWrapper);
    const characterElements = [];
    for (const word of chunk) {
      if (!word.word.trim()) {
        wrapperWordEl.appendChild(document.createTextNode(word.word));
        continue;
      }
      const realWord = this.createWord(word, emp);
      if (emp) characterElements.push(...realWord.subElements);
      this.splittedWords.push(realWord);
      wrapperWordEl.appendChild(realWord.mainElement);
    }
    if (emp && this.splittedWords.length > 0) {
      const lastWordOfChunk = this.splittedWords[this.splittedWords.length - 1];
      const rubyCharCount = chunk.reduce((total, word) => total + this.getRubyCharCount(word), 0);
      const lineWords = this.lyricLine.words;
      const isLastWord = lineWords.length > 0 && merged.word.includes(lineWords[lineWords.length - 1].word);
      lastWordOfChunk.elementAnimations.push(...createEmphasizeAnimation({
        word: merged,
        characterElements,
        duration: merged.endTime - merged.startTime,
        delay: merged.startTime - this.lyricLine.startTime,
        rubyCharCount,
        isBG: this.lyricLine.isBG,
        isLastWord
      }));
    }
    main.appendChild(wrapperWordEl);
  }
  onLineSizeChange(_size) {
    this.updateMaskImageSync();
  }
  updateMaskImageSync() {
    for (const word of this.splittedWords) {
      const el = word.mainElement;
      if (el) {
        word.padding = Number.parseFloat(getComputedStyle(el).paddingLeft);
        word.width = el.clientWidth - word.padding * 2;
        word.height = el.clientHeight - word.padding * 2;
      } else {
        word.width = 0;
        word.height = 0;
        word.padding = 0;
      }
    }
    if (this.balancer && LyricLineBase.wordSegmenter) this.balancer.balanceLineBreaks(this.lyricPlayer._getIsNonDynamic(), this.splittedWords.length > 0, LyricLineBase.wordSegmenter);
    this.maskAnimator?.dispose();
    const maxEndTime = Math.max(0, ...this.splittedWords.map((w) => w.endTime), this.lyricLine.endTime);
    this.maskAnimator = createLineMaskAnimator(this.splittedWords, {
      lineStartTime: this.lyricLine.startTime,
      lineEndTime: maxEndTime,
      wordFadeWidth: this.lyricPlayer.getWordFadeWidth(),
      supportMaskImage: this.lyricPlayer.supportMaskImage
    });
    this.maskAnimator.apply();
    if (this.isEnabled) {
      const isPlayerRunning = this.lyricPlayer.getIsPlaying?.() ?? true;
      this.enable(this.lyricPlayer.getCurrentTime(), isPlayerRunning);
    }
  }
  getElement() {
    return this.element;
  }
  setRenderMode(mode) {
    if (this.renderMode === mode) return;
    this.renderMode = mode;
    this.element.classList.toggle(lyric_player_module_default.gradientMask, mode === LyricLineRenderMode.GRADIENT);
  }
  setTransform(scale = this.scale, opacity = this.opacity, blur = 0, delay = Duration.ZERO, mode = LyricLineRenderMode.SOLID) {
    super.setTransform(scale, opacity, blur, delay);
    this.setRenderMode(mode);
    this.top = 0;
    this.scale = scale;
    this.delay = delay;
    if (this.lyricPlayer.getEnableSpring()) this.lineTransforms.scale.setTargetPosition(scale);
    else this.lineTransforms.scale.setPosition(scale);
  }
  update(delta = Duration.ZERO) {
    if (!this.lyricPlayer.getEnableSpring()) return;
    const scaleMoving = !this.lineTransforms.scale.arrived();
    this.lineTransforms.scale.update(delta);
    if (scaleMoving) this.isUiDirty = true;
  }
  commitChanges() {
    if (this.isUiDirty) {
      this.rebuildStyle();
      this.isUiDirty = false;
    }
  }
  /** @internal */
  _getDebugTargetPos() {
    return `[\u4F4D\u79FB: ${this.top}; \u7F29\u653E: ${this.scale}; \u5EF6\u65F6: ${this.delay}]`;
  }
  disposeElements() {
    this.balancer?.reset();
    this.maskAnimator?.dispose();
    this.maskAnimator = void 0;
    for (const realWord of this.splittedWords) {
      for (const a of realWord.elementAnimations) a.cancel();
      for (const sub of realWord.subElements) {
        sub.remove();
        sub.parentNode?.removeChild(sub);
      }
      realWord.elementAnimations = [];
      realWord.subElements = [];
      if (realWord.mainElement?.parentNode) realWord.mainElement.parentNode.removeChild(realWord.mainElement);
    }
    this.splittedWords = [];
    const main = this.element.children[0];
    const trans = this.element.children[1];
    const roman = this.element.children[2];
    // Aurora patch: replaceChildren() instead of innerHTML="" — music.youtube.com
    // enforces `require-trusted-types-for 'script'`, so every innerHTML write
    // throws "This document requires 'TrustedHTML' assignment" and aborts
    // DomLyricPlayer.update(). replaceChildren() is not a Trusted Types sink.
    if (main) main.replaceChildren();
    if (trans) trans.replaceChildren();
    if (roman) roman.replaceChildren();
  }
  dispose() {
    this.disposeElements();
    this.lyricPlayer.resizeObserver.unobserve(this.element);
    this.element.remove();
  }
};
var LyricLineMouseEvent = class extends MouseEvent {
  lineIndex;
  line;
  bgLine;
  /**
  * 自定义标志位，用于记录外部是否调用了 `stopPropagation`
  */
  isPropagationStopped = false;
  constructor(lineIndex, line, bgLine, event) {
    super(`line-${event.type}`, event);
    this.lineIndex = lineIndex;
    this.line = line;
    this.bgLine = bgLine;
  }
  stopPropagation() {
    this.isPropagationStopped = true;
    super.stopPropagation();
  }
  stopImmediatePropagation() {
    this.isPropagationStopped = true;
    super.stopImmediatePropagation();
  }
};
var DomLyricPlayer = class extends LyricPlayerBase {
  abortController = new AbortController();
  currentLyricGroups = [];
  onResize() {
    const computedStyles = getComputedStyle(this.element);
    this._baseFontSize = Number.parseFloat(computedStyles.fontSize);
    this.rebuildStyle();
  }
  supportPlusLighter = CSS.supports("mix-blend-mode", "plus-lighter");
  supportMaskImage = CSS.supports("mask-image", "none");
  innerSize = [0, 0];
  onMouseEventHandler = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const groupEl = target.closest(`.${lyric_player_module_default.lyricLineWrapper}`);
    if (!groupEl) return;
    const group = this.lyricGroupElementMap.get(groupEl);
    if (!group) return;
    const mainLine = group.mainLine;
    const bgLine = group.bgLine;
    const evt = new LyricLineMouseEvent(this.lyricLinesIndexes.get(mainLine) ?? -1, mainLine, bgLine, e);
    if (!this.dispatchEvent(evt) || evt.defaultPrevented) e.preventDefault();
    if (evt.isPropagationStopped) {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  };
  /**
  * 是否为非逐词歌词
  * @internal
  */
  _getIsNonDynamic() {
    return this.isNonDynamic;
  }
  _baseFontSize = Number.parseFloat(getComputedStyle(this.element).fontSize);
  get baseFontSize() {
    return this._baseFontSize;
  }
  constructor() {
    super();
    this.onResize();
    this.element.classList.add("amll-lyric-player", "dom");
    if (this.disableSpring) this.element.classList.add(lyric_player_module_default.disableSpring);
    this.element.addEventListener("click", this.onMouseEventHandler, { signal: this.abortController.signal });
    this.element.addEventListener("contextmenu", this.onMouseEventHandler, { signal: this.abortController.signal });
  }
  rebuildStyle() {
  }
  setWordFadeWidth(value = 0.5) {
    super.setWordFadeWidth(value);
    for (const group of this.currentLyricGroups) {
      group.mainLine.updateMaskImageSync();
      group.bgLine?.updateMaskImageSync();
    }
  }
  createInterludeDots() {
    return new InterludeDotsEl();
  }
  createBottomLine() {
    return new BottomLineEl(this);
  }
  /**
  * 重新构建歌词行和时间状态
  *
  * 一般用于在调用 {@link setLyricProcessConfig} 更新配置后手动刷新视图，
  * 或在外部样式/DOM 结构发生改变后重置歌词视图
  *
  * @param initialTime 重建后对齐的初始时间（毫秒），默认使用当前播放进度
  */
  buildLyricGroups() {
    if (this.hasDuetLine) this.element.classList.add(lyric_player_module_default.hasDuetLine);
    else this.element.classList.remove(lyric_player_module_default.hasDuetLine);
    let currentGroup = null;
    for (let i = 0; i < this.processedLines.length; i++) {
      const line = this.processedLines[i];
      const lineEl = new LyricLineEl(this, line);
      this.lyricLinesIndexes.set(lineEl, i);
      if (!line.isBG || !currentGroup) {
        currentGroup = new LyricLineGroup(this, lineEl);
        this.currentLyricGroups.push(currentGroup);
        this.lyricGroupElementMap.set(currentGroup.element, currentGroup);
      } else currentGroup.addBgLine(lineEl);
    }
  }
  rebuildLyricView(initialTime = this.getCurrentTime()) {
    super.rebuildLyricView(initialTime);
    this.setLinePosXSpringParams({});
    this.setLinePosYSpringParams({});
    this.setLineScaleSpringParams({});
    this.update(0);
  }
  pause() {
    super.pause();
    this.element.classList.remove(lyric_player_module_default.playing);
    for (const group of this.currentLyricGroups) {
      group.mainLine.pause();
      group.bgLine?.pause();
    }
  }
  resume() {
    super.resume();
    this.element.classList.add(lyric_player_module_default.playing);
    for (const group of this.currentLyricGroups) {
      group.mainLine.resume();
      group.bgLine?.resume();
    }
  }
  update(delta = 0) {
    const d = Duration.min(Duration.fromMillis(delta), MAX_FRAME_DELTA);
    super.update(Duration.asMillis(d));
    // Aurora patch: deliberately does NOT write --amll-player-time here. While it
    // lived on the player root, every word in the panel re-resolved its CSS mask
    // every frame - ~80 style recalculations to move 5 words. The host now sets
    // the variable on the ACTIVE line's element instead (amllDrive in
    // 22-amll-integration), so only that line's words recompute.
    if (!this.isPageVisible) return;
    for (const group of this.currentLyricGroups) group.update(d);
    for (const group of this.currentLyricGroups) group.commitChanges();
  }
  dispose() {
    super.dispose();
    this.abortController.abort();
    this.element.remove();
    for (const group of this.currentLyricGroups) group.dispose();
  }
};
export {
  AbstractBaseRenderer,
  BackgroundRender,
  BaseRenderer,
  DomLyricPlayer,
  Duration,
  GLProgram,
  IsolationRenderer,
  LayoutAlignAnchor,
  LayoutReason,
  LayoutReasonStrategyMap,
  LyricLineMouseEvent,
  LyricLineRenderMode,
  DomLyricPlayer as LyricPlayer,
  LyricPlayerBase,
  MAX_FRAME_DELTA,
  MaskObsceneWordsMode,
  MediaTime,
  MeshGradientRenderer,
  PixiRenderer,
  buildColorHistogram,
  channelToLinear,
  createAutoPalette,
  createKMeansPalette,
  createOctTreePalette,
  createPaletteFromImage,
  createThemeColor,
  hsvToRgb,
  labToRgb,
  labToXyz,
  paletteRgbLStarIsDark,
  paletteRgbLStarIsLight,
  rgbLStarIsDark,
  rgbToHsv,
  rgbToLab,
  rgbToXyz,
  spring_exports as spring,
  srgbToOkLab,
  xyzToLab,
  xyzToRgb,
  yToLStar
};
