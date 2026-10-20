/*
 * Snippet — "Now Playing panel" (Phase 1).
 *
 * A Spotify-NPV-style rail pinned to the right of YouTube Music. Shows the
 * current cover art, title, artist and album, with like / dislike / more and a
 * collapse control. Collapsing slides the card off-screen but leaves a thin
 * clickable edge, exactly like Spotify's NPV. The rail width is resizable by
 * dragging its left edge; the chosen width persists.
 *
 * Layout: the rail sits between the top nav bar (64px) and the bottom player
 * bar (72px) — it ends ABOVE the player bar, which stays full-width. The watch
 * page and home content shift left to make room; the nav bar doesn't move.
 * Below the hero lives a lyrics dock: while the rail is open on any page OTHER
 * than the song view, the live Synced Lyrics panel (#ym-sl-panel — the SAME
 * node the Lyrics tab uses, same renderer) is moved into it. On the song view
 * (and whenever the rail collapses) it is returned to the Lyrics tab. The
 * frosted glass is a dedicated background layer, separate from the content, so
 * the lyrics' per-frame animations never re-composite the blur.
 *
 * Data: window.YTMod.player.getTrack() (page world), with a player-bar DOM
 * fallback. Track polling is 800ms.
 */
(function () {
  "use strict";

  const EXT_ID = "snippet-npv-panel";
  const TAG = "[snippet:npv]";
  /* Kawarp 1.3.1 (MIT, Better Lyrics) inlined. A separate <script src> did not
     load in this browser, so the class lives in this IIFE instead — no network
     request, no page-world global, no CSP dependency. Licence:/n     src/extensions/kawarp-video.LICENSE.txt */
  const KawarpClass = (function () {
"use strict";
/**
 * Kawarp - Fluid Animated Background Renderer
 *
 * Creates a fluid, animated background effect similar to Apple Music's album art visualization.
 * Uses WebGL with Kawase blur and domain warping techniques.
 *
 * Optimized architecture:
 * - Blur runs on small textures (128x128) only when image changes
 * - Smooth crossfade transitions between images
 * - Instant first frame without black buffer crossfade
 * - High-precision FBO tracking and resolution management
 * - Robust CORS and blob/imageBitmap loading
 */
// Size for blur operations (small = fast)
const BLUR_SIZE = 128;
const DEFAULT_VIDEO_OPTIONS = {
    sampleWidth: 128,
    sampleHeight: 72,
    downsampleFactor: 2,
    frameRate: 0,
    smoothing: 0,
};
// A media-time jump larger than this between frames is a seek, not playback.
const VIDEO_SEEK_THRESHOLD_SECONDS = 0.25;
// Time constants after the last video frame before easing snaps and goes idle
const VIDEO_SMOOTHING_SETTLE_RESPONSES = 8;
const boundedOption = (value, fallback, min, max) => typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
const textureSourceSize = (source) => {
    if ("naturalWidth" in source)
        return [source.naturalWidth, source.naturalHeight];
    if ("videoWidth" in source)
        return [source.videoWidth, source.videoHeight];
    if ("displayWidth" in source)
        return [source.displayWidth, source.displayHeight];
    return [source.width, source.height];
};
const VERTEX_SHADER = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`;
const KAWASE_BLUR_SHADER = `
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec2 u_resolution;
  uniform float u_offset;
  varying vec2 v_texCoord;

  void main() {
    highp vec2 texelSize = 1.0 / u_resolution;
    highp vec4 color = vec4(0.0);

    color += texture2D(u_texture, v_texCoord + vec2(-u_offset, -u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(u_offset, -u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(-u_offset, u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(u_offset, u_offset) * texelSize);

    gl_FragColor = color * 0.25;
  }
`;
// Blend shader for crossfading between two textures
const BLEND_SHADER = `
  precision highp float;
  uniform sampler2D u_texture1;
  uniform sampler2D u_texture2;
  uniform float u_blend;
  varying vec2 v_texCoord;

  void main() {
    vec4 color1 = texture2D(u_texture1, v_texCoord);
    vec4 color2 = texture2D(u_texture2, v_texCoord);
    gl_FragColor = mix(color1, color2, u_blend);
  }
`;
// Tint shader - applies color to dark areas before blur
const TINT_SHADER = `
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec3 u_tintColor;
  uniform float u_tintIntensity;
  varying vec2 v_texCoord;

  void main() {
    vec4 color = texture2D(u_texture, v_texCoord);
    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));

    // darkMask: 1.0 for black, 0.0 for luma >= 0.5
    float darkMask = 1.0 - smoothstep(0.0, 0.5, luma);

    // Blend dark areas toward tint color
    color.rgb = mix(color.rgb, u_tintColor, darkMask * u_tintIntensity);

    gl_FragColor = color;
  }
`;
const DOMAIN_WARP_SHADER = `
  precision highp float;
  uniform sampler2D u_texture;
  uniform float u_time;
  uniform float u_intensity;
  varying vec2 v_texCoord;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                        -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vec2 uv = v_texCoord;
    float t = u_time * 0.05;

    vec2 center = uv - 0.5;
    float centerWeight = 1.0 - smoothstep(0.0, 0.7, length(center));

    // Large-scale movement (slow, big blobs)
    float n1 = snoise(uv * 0.35 + vec2(t, t * 0.7));
    float n2 = snoise(uv * 0.35 + vec2(-t * 0.8, t * 0.5) + vec2(50.0, 50.0));

    // Medium-scale detail (adds organic movement)
    float n3 = snoise(uv * 0.9 + vec2(t * 1.2, -t) + vec2(100.0, 0.0));
    float n4 = snoise(uv * 0.9 + vec2(-t, t * 1.1) + vec2(0.0, 100.0));

    // Combine two octaves
    vec2 warp = vec2(
      n1 * 0.65 + n3 * 0.35,
      n2 * 0.65 + n4 * 0.35
    ) * centerWeight;

    vec2 warpedUV = uv + warp * u_intensity;
    warpedUV = clamp(warpedUV, 0.0, 1.0);

    gl_FragColor = texture2D(u_texture, warpedUV);
  }
`;
const OUTPUT_SHADER = `
  precision highp float;
  uniform sampler2D u_texture;
  uniform float u_saturation;
  uniform float u_dithering;
  uniform float u_time;
  uniform float u_scale;
  uniform vec2 u_resolution;
  varying vec2 v_texCoord;

  highp float hash(highp vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec2 uv = (v_texCoord - 0.5) / u_scale + 0.5;
    uv = clamp(uv, 0.0, 1.0);

    vec4 color = texture2D(u_texture, uv);

    vec2 center = v_texCoord - 0.5;
    float vignette = 1.0 - dot(center, center) * 0.3;
    color.rgb *= vignette;

    float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(vec3(gray), color.rgb, u_saturation);

    highp vec2 pixelPos = floor(v_texCoord * u_resolution);
    highp float noise = hash(vec3(pixelPos, floor(u_time * 60.0)));
    color.rgb += (noise - 0.5) * u_dithering;

    gl_FragColor = color;
  }
`;
// Four bilinear taps average a 4x4 source footprint for reductions up to 4x
const DOWNSAMPLE_SHADER = `
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec2 u_texelSize;
  varying vec2 v_texCoord;

  void main() {
    vec2 offset = u_texelSize * 0.25;
    gl_FragColor = 0.25 * (
      texture2D(u_texture, v_texCoord + vec2(-offset.x, -offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(offset.x, -offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(-offset.x, offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(offset.x, offset.y))
    );
  }
`;
// Moves at least one storage step toward the target, so half-float and 8-bit
// history cannot stall short of it when the per-frame response is tiny
const SMOOTHING_SHADER = `
  precision highp float;
  uniform sampler2D u_texture;
  uniform sampler2D u_history;
  uniform float u_response;
  uniform float u_minStep;
  varying vec2 v_texCoord;

  void main() {
    vec4 history = texture2D(u_history, v_texCoord);
    vec4 current = texture2D(u_texture, v_texCoord);
    vec4 blended = mix(history, current, u_response);
    vec4 remaining = current - history;
    vec4 minimal = history + sign(remaining) * min(abs(remaining), vec4(u_minStep));
    gl_FragColor = mix(
      minimal,
      blended,
      step(abs(minimal - history), abs(blended - history))
    );
  }
`;
class Kawarp {
    canvas;
    gl;
    halfFloatExt = null;
    halfFloatLinearExt = null;
    // Shader programs
    blurProgram;
    blendProgram;
    tintProgram;
    warpProgram;
    outputProgram;
    // Buffers
    positionBuffer;
    texCoordBuffer;
    // Source texture (original image)
    sourceTexture;
    // Small FBOs for blur (BLUR_SIZE x BLUR_SIZE)
    blurFBO1;
    blurFBO2;
    // Album FBOs for crossfade (BLUR_SIZE x BLUR_SIZE)
    currentAlbumFBO;
    nextAlbumFBO;
    // Full-res FBO for warp output
    warpFBO;
    // Animation state
    animationId = null;
    lastFrameTime = 0;
    accumulatedTime = 0;
    isPlaying = false;
    disposed = false;
    // Transition state
    isTransitioning = false;
    transitionStartTime = 0;
    _transitionDuration;
    // Options
    _warpIntensity;
    _blurPasses;
    _animationSpeed;
    _targetAnimationSpeed;
    _saturation;
    _tintColor;
    _tintIntensity;
    _dithering;
    _scale;
    hasImage = false;
    // WebGL2 high-precision state (null/false on the default WebGL1 path)
    gl2;
    halfFloatRenderTargets = false;
    float32RenderTargets = false;
    floatLinearFiltering = false;
    _highPrecisionOutput = false;
    highPrecisionInputRequested;
    // Texture the blur reads from: the image source or the latest video frame
    activeSourceTexture;
    imageSourceWidth = 0;
    imageSourceHeight = 0;
    videoFrameWidth = 0;
    videoFrameHeight = 0;
    // Video source state
    video = null;
    // An in-flight image load is dropped only when a later loadVideo call has
    // since put a video frame on screen
    videoLoadCount = 0;
    // videoLoadCount of the last video that put a frame on screen
    shownVideoLoad = 0;
    videoOptions = { ...DEFAULT_VIDEO_OPTIONS };
    videoCallbackId = null;
    videoUploadTexture = null;
    videoStages = [];
    videoHistory = [];
    videoHistoryIndex = 0;
    hasVideoHistory = false;
    // Latest downsampled frame the history is easing toward, null once settled
    videoSmoothingTarget = null;
    videoSmoothingTargetAt = 0;
    videoSmoothedAt = 0;
    // Smallest change the history format can store; 0 for float32
    videoHistoryStep = 0;
    // Ideal time of the last sample on the frameRate cadence
    videoSampleSlot = Number.NEGATIVE_INFINITY;
    videoTargetsStale = true;
    videoSourceWidth = 0;
    videoSourceHeight = 0;
    videoFrameTime = 0;
    videoMediaTime = 0;
    videoFrameShown = false;
    videoFramePending = false;
    retainedVideoFrame = null;
    samplingPrograms = null;
    sampleTargets = [];
    sampleTargetsLayout = [0, 0, 0];
    pendingSampleSize = 0;
    samplePixelBuffer = null;
    pendingSample = null;
    // Cached attribute locations
    attribs;
    // Cached uniform locations
    uniforms;
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        const contextAttributes = {
            alpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: true,
            powerPreference: "high-performance",
        };
        const gl2 = options.highPrecisionInput || options.highPrecisionOutput
            ? canvas.getContext("webgl2", contextAttributes)
            : null;
        const gl = gl2 ?? canvas.getContext("webgl", contextAttributes);
        if (!gl)
            throw new Error("WebGL not supported");
        this.gl = gl;
        this.gl2 = gl2;
        this.highPrecisionInputRequested = !!gl2 && !!options.highPrecisionInput;
        this.halfFloatExt = gl.getExtension("OES_texture_half_float");
        this.halfFloatLinearExt = gl.getExtension("OES_texture_half_float_linear");
        if (gl2) {
            this.float32RenderTargets = !!gl2.getExtension("EXT_color_buffer_float");
            this.halfFloatRenderTargets =
                this.float32RenderTargets ||
                    !!gl2.getExtension("EXT_color_buffer_half_float");
            this.floatLinearFiltering = !!gl2.getExtension("OES_texture_float_linear");
        }
        this._warpIntensity = options.warpIntensity ?? 1.0;
        this._blurPasses = options.blurPasses ?? 8;
        this._animationSpeed = options.animationSpeed ?? 1.0;
        this._targetAnimationSpeed = this._animationSpeed;
        this._transitionDuration = options.transitionDuration ?? 1000;
        this._saturation = options.saturation ?? 1.5;
        this._tintColor = options.tintColor ?? [0.157, 0.157, 0.235];
        this._tintIntensity = options.tintIntensity ?? 0.15;
        this._dithering = options.dithering ?? 0.008;
        this._scale = options.scale ?? 1.0;
        // Create shader programs
        this.blurProgram = this.createProgram(VERTEX_SHADER, KAWASE_BLUR_SHADER);
        this.blendProgram = this.createProgram(VERTEX_SHADER, BLEND_SHADER);
        this.tintProgram = this.createProgram(VERTEX_SHADER, TINT_SHADER);
        this.warpProgram = this.createProgram(VERTEX_SHADER, DOMAIN_WARP_SHADER);
        this.outputProgram = this.createProgram(VERTEX_SHADER, OUTPUT_SHADER);
        // Cache attribute locations (same for all programs since they use same vertex shader)
        this.attribs = {
            position: gl.getAttribLocation(this.blurProgram, "a_position"),
            texCoord: gl.getAttribLocation(this.blurProgram, "a_texCoord"),
        };
        // Cache uniform locations
        this.uniforms = {
            blur: {
                resolution: gl.getUniformLocation(this.blurProgram, "u_resolution"),
                texture: gl.getUniformLocation(this.blurProgram, "u_texture"),
                offset: gl.getUniformLocation(this.blurProgram, "u_offset"),
            },
            blend: {
                texture1: gl.getUniformLocation(this.blendProgram, "u_texture1"),
                texture2: gl.getUniformLocation(this.blendProgram, "u_texture2"),
                blend: gl.getUniformLocation(this.blendProgram, "u_blend"),
            },
            warp: {
                texture: gl.getUniformLocation(this.warpProgram, "u_texture"),
                time: gl.getUniformLocation(this.warpProgram, "u_time"),
                intensity: gl.getUniformLocation(this.warpProgram, "u_intensity"),
            },
            tint: {
                texture: gl.getUniformLocation(this.tintProgram, "u_texture"),
                tintColor: gl.getUniformLocation(this.tintProgram, "u_tintColor"),
                tintIntensity: gl.getUniformLocation(this.tintProgram, "u_tintIntensity"),
            },
            output: {
                texture: gl.getUniformLocation(this.outputProgram, "u_texture"),
                saturation: gl.getUniformLocation(this.outputProgram, "u_saturation"),
                dithering: gl.getUniformLocation(this.outputProgram, "u_dithering"),
                time: gl.getUniformLocation(this.outputProgram, "u_time"),
                scale: gl.getUniformLocation(this.outputProgram, "u_scale"),
                resolution: gl.getUniformLocation(this.outputProgram, "u_resolution"),
            },
        };
        // Create buffers
        this.positionBuffer = this.createBuffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
        this.texCoordBuffer = this.createBuffer(new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]));
        // Create source texture
        this.sourceTexture = this.createTexture();
        this.activeSourceTexture = this.sourceTexture;
        // Create small FBOs for blur operations (high precision to avoid banding)
        this.blurFBO1 = this.createFramebuffer(BLUR_SIZE, BLUR_SIZE, true);
        this.blurFBO2 = this.createFramebuffer(BLUR_SIZE, BLUR_SIZE, true);
        // Create album FBOs for crossfade (high precision to avoid banding)
        this.currentAlbumFBO = this.createFramebuffer(BLUR_SIZE, BLUR_SIZE, true);
        this.nextAlbumFBO = this.createFramebuffer(BLUR_SIZE, BLUR_SIZE, true);
        const initW = Math.max(1, canvas.width || 640);
        const initH = Math.max(1, canvas.height || 360);
        this.warpFBO = this.createFramebuffer(initW, initH, true);
        if (options.highPrecisionOutput)
            this.applyFloatDrawingBuffer();
    }
    /** Whether the drawing buffer is float16 (requested via highPrecisionOutput) */
    get highPrecisionOutput() {
        return this._highPrecisionOutput;
    }
    /** Whether smoothed video keeps float32 color history (requested via highPrecisionInput) */
    get highPrecisionInput() {
        return this.highPrecisionInputRequested && this.float32RenderTargets;
    }
    // Getters and setters
    get warpIntensity() {
        return this._warpIntensity;
    }
    set warpIntensity(value) {
        this._warpIntensity = Math.max(0, Math.min(1, value));
    }
    get blurPasses() {
        return this._blurPasses;
    }
    set blurPasses(value) {
        const newValue = Math.max(0, Math.min(40, Math.floor(value)));
        if (newValue !== this._blurPasses) {
            this._blurPasses = newValue;
            // Re-blur with new pass count if we have an image
            if (this.hasImage) {
                this.reblurCurrentImage();
            }
        }
    }
    get animationSpeed() {
        return this._targetAnimationSpeed;
    }
    set animationSpeed(value) {
        this._targetAnimationSpeed = Math.max(0, Math.min(16, value));
    }
    get transitionDuration() {
        return this._transitionDuration;
    }
    set transitionDuration(value) {
        this._transitionDuration = Math.max(0, Math.min(5000, value));
    }
    get saturation() {
        return this._saturation;
    }
    set saturation(value) {
        this._saturation = Math.max(0, Math.min(3, value));
    }
    get tintColor() {
        return this._tintColor;
    }
    set tintColor(value) {
        const newValue = value.map((v) => Math.max(0, Math.min(1, v)));
        const changed = newValue.some((v, i) => v !== this._tintColor[i]);
        if (changed) {
            this._tintColor = newValue;
            if (this.hasImage) {
                this.reblurCurrentImage();
            }
        }
    }
    get tintIntensity() {
        return this._tintIntensity;
    }
    set tintIntensity(value) {
        const newValue = Math.max(0, Math.min(1, value));
        if (newValue !== this._tintIntensity) {
            this._tintIntensity = newValue;
            if (this.hasImage) {
                this.reblurCurrentImage();
            }
        }
    }
    get dithering() {
        return this._dithering;
    }
    set dithering(value) {
        this._dithering = Math.max(0, Math.min(0.1, value));
    }
    get scale() {
        return this._scale;
    }
    set scale(value) {
        this._scale = Math.max(0.01, Math.min(4, value));
    }
    setOptions(options) {
        if (options.warpIntensity !== undefined)
            this.warpIntensity = options.warpIntensity;
        if (options.blurPasses !== undefined)
            this.blurPasses = options.blurPasses;
        if (options.animationSpeed !== undefined)
            this.animationSpeed = options.animationSpeed;
        if (options.transitionDuration !== undefined)
            this.transitionDuration = options.transitionDuration;
        if (options.saturation !== undefined)
            this.saturation = options.saturation;
        if (options.tintColor !== undefined)
            this.tintColor = options.tintColor;
        if (options.tintIntensity !== undefined)
            this.tintIntensity = options.tintIntensity;
        if (options.dithering !== undefined)
            this.dithering = options.dithering;
        if (options.scale !== undefined)
            this.scale = options.scale;
    }
    getOptions() {
        return {
            warpIntensity: this._warpIntensity,
            blurPasses: this._blurPasses,
            animationSpeed: this._targetAnimationSpeed,
            transitionDuration: this._transitionDuration,
            saturation: this._saturation,
            tintColor: this._tintColor,
            tintIntensity: this._tintIntensity,
            dithering: this._dithering,
            scale: this._scale,
        };
    }
    // Image loading methods
    async loadImage(src) {
        if (!src)
            return;
        const videoLoadsAtStart = this.videoLoadCount;
        let bitmap = null;
        try {
            const res = await fetch(src, { mode: "cors" });
            if (res.ok) {
                const blob = await res.blob();
                bitmap = await createImageBitmap(blob);
            }
        }
        catch {
            // ignore fetch failure and proceed to image fallback
        }
        if (!bitmap) {
            bitmap = await new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
                img.src = src;
            });
        }
        if (this.disposed || this.shownVideoLoad > videoLoadsAtStart) {
            if ("close" in bitmap)
                bitmap.close();
            return;
        }
        const posterForVideo = !!this.video && this.videoLoadCount !== videoLoadsAtStart;
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        [this.imageSourceWidth, this.imageSourceHeight] = textureSourceSize(bitmap);
        if ("close" in bitmap &&
            typeof bitmap.close === "function") {
            bitmap.close();
        }
        this.processNewImage(this.sourceTexture, posterForVideo);
    }
    loadImageElement(source) {
        this.showImageElement(source, false);
    }
    showImageElement(source, posterForVideo) {
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.sourceTexture);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, source);
        [this.imageSourceWidth, this.imageSourceHeight] = textureSourceSize(source);
        this.processNewImage(this.sourceTexture, posterForVideo);
    }
    loadImageData(data, width, height) {
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.sourceTexture);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, width, height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, data instanceof Uint8ClampedArray ? new Uint8Array(data.buffer) : data);
        this.imageSourceWidth = width;
        this.imageSourceHeight = height;
        this.processNewImage();
    }
    loadFromImageData(imageData) {
        this.loadImageData(imageData.data, imageData.width, imageData.height);
    }
    async loadBlob(blob) {
        const videoLoadsAtStart = this.videoLoadCount;
        const bitmap = await createImageBitmap(blob);
        if (this.disposed || this.shownVideoLoad > videoLoadsAtStart) {
            bitmap.close();
            return;
        }
        const posterForVideo = !!this.video && this.videoLoadCount !== videoLoadsAtStart;
        this.showImageElement(bitmap, posterForVideo);
        bitmap.close();
    }
    loadBase64(base64) {
        const src = base64.startsWith("data:")
            ? base64
            : `data:image/png;base64,${base64}`;
        return this.loadImage(src);
    }
    async loadArrayBuffer(buffer, mimeType = "image/png") {
        const blob = new Blob([buffer], { type: mimeType });
        return this.loadBlob(blob);
    }
    loadGradient(colors, angle = 135) {
        const size = 512;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return;
        const angleRad = (angle * Math.PI) / 180;
        const x1 = size / 2 - Math.cos(angleRad) * size;
        const y1 = size / 2 - Math.sin(angleRad) * size;
        const x2 = size / 2 + Math.cos(angleRad) * size;
        const y2 = size / 2 + Math.sin(angleRad) * size;
        const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
        colors.forEach((color, i) => {
            gradient.addColorStop(i / (colors.length - 1), color);
        });
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        this.loadImageElement(canvas);
    }
    /**
     * Use a playing video as the source. Each decoded frame is imported on the
     * GPU, downsampled in stages, optionally smoothed over time, and blurred in
     * place. The first frame crossfades from the current image (instantly on a
     * stopped instance). Video renders
     * upright; images keep their historical flipped orientation.
     *
     * Calling again with the same element only updates the options. A stopped
     * instance skips frames from a playing video and draws single frames from a
     * paused one, so seeking while paused stays visible.
     */
    loadVideo(video, options = {}) {
        if (this.disposed)
            return;
        if (typeof video.requestVideoFrameCallback !== "function") {
            throw new Error("Video sources require requestVideoFrameCallback");
        }
        const isNewVideo = this.video !== video;
        if (isNewVideo) {
            this.videoLoadCount++;
            this.unloadVideo();
            this.video = video;
            this.videoFrameShown = false;
            this.hasVideoHistory = false;
            this.videoSampleSlot = Number.NEGATIVE_INFINITY;
        }
        const nextOptions = {
            sampleWidth: Math.round(boundedOption(options.sampleWidth, DEFAULT_VIDEO_OPTIONS.sampleWidth, 1, 1024)),
            sampleHeight: Math.round(boundedOption(options.sampleHeight, DEFAULT_VIDEO_OPTIONS.sampleHeight, 1, 1024)),
            downsampleFactor: boundedOption(options.downsampleFactor, DEFAULT_VIDEO_OPTIONS.downsampleFactor, 1.25, 4),
            frameRate: boundedOption(options.frameRate, DEFAULT_VIDEO_OPTIONS.frameRate, 0, 240),
            smoothing: boundedOption(options.smoothing, DEFAULT_VIDEO_OPTIONS.smoothing, 0, 10000),
            onError: options.onError,
        };
        const previousOptions = this.videoOptions;
        if (isNewVideo ||
            nextOptions.sampleWidth !== previousOptions.sampleWidth ||
            nextOptions.sampleHeight !== previousOptions.sampleHeight ||
            nextOptions.downsampleFactor !== previousOptions.downsampleFactor ||
            nextOptions.smoothing > 0 !== previousOptions.smoothing > 0) {
            this.videoTargetsStale = true;
        }
        this.videoOptions = nextOptions;
        this.requestVideoFrame();
        if (video.readyState >= video.HAVE_CURRENT_DATA &&
            (isNewVideo || (video.paused && this.videoTargetsStale))) {
            this.processVideoFrame(performance.now(), video.currentTime);
        }
    }
    /**
     * Stop following the video. The last frame stays on screen until the next
     * image or video is loaded.
     */
    unloadVideo() {
        const video = this.video;
        if (!video)
            return;
        if (this.videoCallbackId !== null) {
            video.cancelVideoFrameCallback(this.videoCallbackId);
            this.videoCallbackId = null;
        }
        video.removeEventListener("pause", this.resumeVideoCallbacks);
        this.video = null;
        this.videoFramePending = false;
        this.releaseVideoTargets();
        if (this.videoUploadTexture) {
            this.gl.deleteTexture(this.videoUploadTexture);
            this.videoUploadTexture = null;
        }
    }
    /**
     * Read a small RGBA8 thumbnail (size x size, bottom row of the rendered
     * orientation first) of the current source, e.g. to measure brightness. WebGL2 reads asynchronously
     * through a pixel buffer and fence; WebGL1 reads synchronously.
     * Resolves to null when there is no source or the instance is disposed.
     */
    sampleSource(size = 32) {
        if (this.disposed || !this.hasImage)
            return Promise.resolve(null);
        const edge = Math.round(boundedOption(size, 32, 1, BLUR_SIZE));
        if (this.pendingSample) {
            return this.pendingSampleSize === edge
                ? this.pendingSample
                : this.pendingSample.then(() => this.sampleSource(edge));
        }
        const gl = this.gl;
        const [sourceWidth, sourceHeight] = this.activeSourceTexture === this.sourceTexture
            ? [this.imageSourceWidth, this.imageSourceHeight]
            : [this.videoFrameWidth, this.videoFrameHeight];
        this.prepareSampleTargets(sourceWidth, sourceHeight, edge);
        let sampledTexture = this.activeSourceTexture;
        for (const stage of this.sampleTargets) {
            this.drawDownsample(sampledTexture, stage);
            sampledTexture = stage.texture;
        }
        const pixels = new Uint8Array(edge * edge * 4);
        const gl2 = this.gl2;
        if (!gl2) {
            gl.readPixels(0, 0, edge, edge, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            return Promise.resolve(pixels);
        }
        this.samplePixelBuffer ??= gl2.createBuffer();
        gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, this.samplePixelBuffer);
        gl2.bufferData(gl2.PIXEL_PACK_BUFFER, pixels.byteLength, gl2.STREAM_READ);
        gl2.readPixels(0, 0, edge, edge, gl2.RGBA, gl2.UNSIGNED_BYTE, 0);
        gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);
        const fence = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!fence)
            return Promise.resolve(null);
        gl2.flush();
        // Timers keep polling in background tabs, where animation frames stop
        const sample = new Promise((resolve) => {
            const poll = () => {
                if (this.disposed) {
                    gl2.deleteSync(fence);
                    resolve(null);
                    return;
                }
                const status = gl2.clientWaitSync(fence, 0, 0);
                if (status === gl2.TIMEOUT_EXPIRED) {
                    setTimeout(poll, 4);
                    return;
                }
                gl2.deleteSync(fence);
                if (status === gl2.WAIT_FAILED) {
                    resolve(null);
                    return;
                }
                gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, this.samplePixelBuffer);
                gl2.getBufferSubData(gl2.PIXEL_PACK_BUFFER, 0, pixels);
                gl2.bindBuffer(gl2.PIXEL_PACK_BUFFER, null);
                resolve(pixels);
            };
            setTimeout(poll, 0);
        }).finally(() => {
            this.pendingSample = null;
        });
        this.pendingSample = sample;
        this.pendingSampleSize = edge;
        return sample;
    }
    /**
     * Halving stages from the source down to size x size. A single 4-tap
     * reduction from full-resolution artwork would skip most texels and alias.
     */
    prepareSampleTargets(sourceWidth, sourceHeight, edge) {
        const [cachedWidth, cachedHeight, cachedEdge] = this.sampleTargetsLayout;
        if (sourceWidth === cachedWidth &&
            sourceHeight === cachedHeight &&
            edge === cachedEdge) {
            return;
        }
        for (const target of this.sampleTargets)
            this.deleteFramebuffer(target);
        this.sampleTargets = [];
        let width = sourceWidth;
        let height = sourceHeight;
        while (width > edge * 2 || height > edge * 2) {
            width = Math.max(edge, Math.ceil(width / 2));
            height = Math.max(edge, Math.ceil(height / 2));
            this.sampleTargets.push(this.createByteFramebuffer(width, height));
        }
        this.sampleTargets.push(this.createByteFramebuffer(edge, edge));
        this.sampleTargetsLayout = [sourceWidth, sourceHeight, edge];
    }
    createByteFramebuffer(width, height) {
        return this.gl2
            ? this.createSizedFramebuffer(width, height, this.gl2.RGBA8)
            : this.createFramebuffer(width, height);
    }
    requestVideoFrame() {
        if (!this.video || this.videoCallbackId !== null)
            return;
        this.videoCallbackId = this.video.requestVideoFrameCallback(this.handleVideoFrame);
    }
    handleVideoFrame = (now, metadata) => {
        this.videoCallbackId = null;
        const video = this.video;
        if (!video || this.disposed)
            return;
        // Stay idle until start(), but wake on pause so a paused seek still redraws
        if (!this.isPlaying && !video.paused) {
            this.videoFramePending = true;
            video.addEventListener("pause", this.resumeVideoCallbacks, {
                once: true,
            });
            return;
        }
        this.requestVideoFrame();
        const { frameRate } = this.videoOptions;
        if (frameRate > 0 && !video.paused) {
            const interval = 1000 / frameRate;
            // Slack keeps jittery frame timing from halving the rate
            if (now < this.videoSampleSlot + interval * 0.75)
                return;
        }
        this.processVideoFrame(now, metadata.mediaTime);
    };
    resumeVideoCallbacks = () => {
        this.requestVideoFrame();
    };
    processVideoFrame(now, mediaTime) {
        const video = this.video;
        if (!video ||
            video.readyState < video.HAVE_CURRENT_DATA ||
            video.videoWidth === 0 ||
            video.videoHeight === 0) {
            return;
        }
        const gl = this.gl;
        const elapsedMs = now - this.videoFrameTime;
        try {
            this.prepareVideoTargets(video.videoWidth, video.videoHeight);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.videoUploadTexture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        }
        catch (error) {
            const { onError } = this.videoOptions;
            this.unloadVideo();
            onError?.(error);
            return;
        }
        finally {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }
        let frameTexture = this.videoUploadTexture;
        for (const stage of this.videoStages) {
            this.drawDownsample(frameTexture, stage);
            frameTexture = stage.texture;
        }
        const { smoothing } = this.videoOptions;
        let easedByRenderLoop = false;
        if (smoothing > 0) {
            const expectedMediaAdvance = (elapsedMs / 1000) * video.playbackRate;
            const seeked = Math.abs(mediaTime - this.videoMediaTime - expectedMediaAdvance) >
                VIDEO_SEEK_THRESHOLD_SECONDS;
            const snap = !this.hasVideoHistory ||
                !this.videoFrameShown ||
                !this.isPlaying ||
                video.paused ||
                seeked;
            if (snap) {
                frameTexture = this.drawSmoothing(frameTexture, 1);
                this.videoSmoothingTarget = null;
            }
            else {
                if (!this.videoSmoothingTarget)
                    this.videoSmoothedAt = now;
                this.videoSmoothingTarget = frameTexture;
                this.videoSmoothingTargetAt = now;
                easedByRenderLoop = true;
            }
            this.hasVideoHistory = true;
        }
        else {
            this.hasVideoHistory = false;
        }
        const { frameRate } = this.videoOptions;
        if (frameRate > 0) {
            const interval = 1000 / frameRate;
            // Advance on a fixed cadence; restart it after falling behind
            this.videoSampleSlot =
                now - this.videoSampleSlot > interval * 2
                    ? now
                    : this.videoSampleSlot + interval;
        }
        this.videoFrameTime = now;
        this.videoMediaTime = mediaTime;
        this.videoFrameWidth = this.videoOptions.sampleWidth;
        this.videoFrameHeight = this.videoOptions.sampleHeight;
        if (!easedByRenderLoop)
            this.showVideoFrame(frameTexture);
    }
    // Easing per animation frame keeps a low frame rate source from stepping
    advanceVideoSmoothing(timestamp) {
        const target = this.videoSmoothingTarget;
        if (!target)
            return;
        const { smoothing } = this.videoOptions;
        const settled = timestamp - this.videoSmoothingTargetAt >=
            smoothing * VIDEO_SMOOTHING_SETTLE_RESPONSES;
        const elapsedMs = Math.max(0, timestamp - this.videoSmoothedAt);
        this.videoSmoothedAt = timestamp;
        const response = settled ? 1 : 1 - Math.exp(-elapsedMs / smoothing);
        this.activeSourceTexture = this.drawSmoothing(target, response);
        this.releaseRetainedVideoFrame();
        this.blurSourceInto(this.nextAlbumFBO);
        if (settled)
            this.videoSmoothingTarget = null;
    }
    showVideoFrame(texture) {
        if (this.videoFrameShown) {
            this.activeSourceTexture = texture;
            this.releaseRetainedVideoFrame();
            this.blurSourceInto(this.nextAlbumFBO);
        }
        else {
            this.videoFrameShown = true;
            this.shownVideoLoad = this.videoLoadCount;
            this.processNewImage(texture);
            // A stopped instance cannot animate the crossfade, so show the frame outright
            if (!this.isPlaying)
                this.isTransitioning = false;
        }
        if (!this.isPlaying)
            this.render(this.accumulatedTime);
    }
    prepareVideoTargets(videoWidth, videoHeight) {
        if (!this.videoTargetsStale &&
            videoWidth === this.videoSourceWidth &&
            videoHeight === this.videoSourceHeight) {
            return;
        }
        this.releaseVideoTargets();
        this.videoUploadTexture ??= this.createTexture();
        const { sampleWidth, sampleHeight, downsampleFactor, smoothing } = this.videoOptions;
        let width = videoWidth;
        let height = videoHeight;
        while (width > sampleWidth * downsampleFactor ||
            height > sampleHeight * downsampleFactor) {
            const nextWidth = Math.max(sampleWidth, Math.ceil(width / downsampleFactor));
            const nextHeight = Math.max(sampleHeight, Math.ceil(height / downsampleFactor));
            // Rounding up can stop shrinking tiny stages; the final stage covers the rest
            if (nextWidth === width && nextHeight === height)
                break;
            width = nextWidth;
            height = nextHeight;
            this.videoStages.push(this.createFramebuffer(width, height, true));
        }
        this.videoStages.push(this.createFramebuffer(sampleWidth, sampleHeight, true));
        if (smoothing > 0) {
            const float32History = this.highPrecisionInputRequested && this.float32RenderTargets;
            for (let i = 0; i < 2; i++) {
                this.videoHistory.push(this.gl2 && float32History
                    ? this.createSizedFramebuffer(sampleWidth, sampleHeight, this.gl2.RGBA32F)
                    : this.createFramebuffer(sampleWidth, sampleHeight, true));
            }
            const halfFloatHistory = this.gl2
                ? this.halfFloatRenderTargets
                : !!(this.halfFloatExt && this.halfFloatLinearExt);
            this.videoHistoryStep = float32History
                ? this.float32RenderTargets
                    ? 0
                    : 1 / 255
                : halfFloatHistory
                    ? 1 / 1024
                    : 1 / 255;
        }
        this.hasVideoHistory = false;
        this.videoSourceWidth = videoWidth;
        this.videoSourceHeight = videoHeight;
        this.videoTargetsStale = false;
    }
    /**
     * Free video render targets. The one the blur currently reads from is
     * retained so re-blurring keeps working until another source replaces it.
     */
    releaseVideoTargets() {
        for (const target of [...this.videoStages, ...this.videoHistory]) {
            if (target.texture === this.activeSourceTexture) {
                this.releaseRetainedVideoFrame();
                this.retainedVideoFrame = target;
            }
            else {
                this.deleteFramebuffer(target);
            }
        }
        this.videoStages = [];
        this.videoHistory = [];
        this.videoSmoothingTarget = null;
        this.videoTargetsStale = true;
    }
    releaseRetainedVideoFrame() {
        if (!this.retainedVideoFrame ||
            this.retainedVideoFrame.texture === this.activeSourceTexture) {
            return;
        }
        this.deleteFramebuffer(this.retainedVideoFrame);
        this.retainedVideoFrame = null;
    }
    getSamplingPrograms() {
        if (this.samplingPrograms)
            return this.samplingPrograms;
        const gl = this.gl;
        const downsample = this.createProgram(VERTEX_SHADER, DOWNSAMPLE_SHADER);
        const smoothing = this.createProgram(VERTEX_SHADER, SMOOTHING_SHADER);
        this.samplingPrograms = {
            downsample,
            smoothing,
            downsampleUniforms: {
                texture: gl.getUniformLocation(downsample, "u_texture"),
                texelSize: gl.getUniformLocation(downsample, "u_texelSize"),
            },
            smoothingUniforms: {
                texture: gl.getUniformLocation(smoothing, "u_texture"),
                history: gl.getUniformLocation(smoothing, "u_history"),
                response: gl.getUniformLocation(smoothing, "u_response"),
                minStep: gl.getUniformLocation(smoothing, "u_minStep"),
            },
        };
        return this.samplingPrograms;
    }
    drawDownsample(source, target) {
        const gl = this.gl;
        const programs = this.getSamplingPrograms();
        gl.useProgram(programs.downsample);
        this.setupAttributes();
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(0, 0, target.width, target.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source);
        gl.uniform1i(programs.downsampleUniforms.texture, 0);
        gl.uniform2f(programs.downsampleUniforms.texelSize, 1 / target.width, 1 / target.height);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    drawSmoothing(source, response) {
        const gl = this.gl;
        const programs = this.getSamplingPrograms();
        const history = this.videoHistory[this.videoHistoryIndex];
        this.videoHistoryIndex = 1 - this.videoHistoryIndex;
        const target = this.videoHistory[this.videoHistoryIndex];
        if (!history || !target)
            return source;
        gl.useProgram(programs.smoothing);
        this.setupAttributes();
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(0, 0, target.width, target.height);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, history.texture);
        gl.uniform1i(programs.smoothingUniforms.history, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source);
        gl.uniform1i(programs.smoothingUniforms.texture, 0);
        gl.uniform1f(programs.smoothingUniforms.response, response);
        gl.uniform1f(programs.smoothingUniforms.minStep, this.videoHistoryStep);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return target.texture;
    }
    /**
     * Process a new image: blur it and start transition
     * This is the key optimization - blur only runs here, not every frame!
     */
    processNewImage(texture = this.sourceTexture, keepVideo = false) {
        if (texture === this.sourceTexture && !keepVideo)
            this.unloadVideo();
        this.activeSourceTexture = texture;
        this.releaseRetainedVideoFrame();
        if (!this.hasImage) {
            this.blurSourceInto(this.nextAlbumFBO);
            this.blurSourceInto(this.currentAlbumFBO);
            this.hasImage = true;
            this.isTransitioning = false;
            return;
        }
        const previousAlbumFBO = this.currentAlbumFBO;
        this.currentAlbumFBO = this.nextAlbumFBO;
        this.nextAlbumFBO = previousAlbumFBO;
        this.blurSourceInto(this.nextAlbumFBO);
        this.isTransitioning = true;
        this.transitionStartTime = performance.now();
    }
    /**
     * Re-blur the current image (used when blurPasses changes)
     * Updates nextAlbumFBO in place without starting a transition
     */
    reblurCurrentImage() {
        this.blurSourceInto(this.nextAlbumFBO);
    }
    /**
     * Blur the source texture into the target FBO (with tint applied before blur)
     */
    blurSourceInto(targetFBO) {
        const gl = this.gl;
        // Step 1: Apply tint to source texture → blurFBO1
        gl.useProgram(this.tintProgram);
        this.setupAttributes();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurFBO1.framebuffer);
        gl.viewport(0, 0, BLUR_SIZE, BLUR_SIZE);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.activeSourceTexture);
        gl.uniform1i(this.uniforms.tint.texture, 0);
        gl.uniform3fv(this.uniforms.tint.tintColor, this._tintColor);
        gl.uniform1f(this.uniforms.tint.tintIntensity, this._tintIntensity);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        // Step 2: Kawase blur passes on the tinted texture
        gl.useProgram(this.blurProgram);
        this.setupAttributes();
        gl.uniform2f(this.uniforms.blur.resolution, BLUR_SIZE, BLUR_SIZE);
        gl.uniform1i(this.uniforms.blur.texture, 0);
        let readFBO = this.blurFBO1;
        let writeFBO = this.blurFBO2;
        for (let i = 0; i < this._blurPasses; i++) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO.framebuffer);
            gl.viewport(0, 0, BLUR_SIZE, BLUR_SIZE);
            gl.bindTexture(gl.TEXTURE_2D, readFBO.texture);
            gl.uniform1f(this.uniforms.blur.offset, i + 0.5);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            const swap = readFBO;
            readFBO = writeFBO;
            writeFBO = swap;
        }
        // Step 3: Copy final blur result to target FBO
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO.framebuffer);
        gl.viewport(0, 0, BLUR_SIZE, BLUR_SIZE);
        gl.bindTexture(gl.TEXTURE_2D, readFBO.texture);
        gl.uniform1f(this.uniforms.blur.offset, 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    resize() {
        const width = Math.max(1, this.canvas.width);
        const height = Math.max(1, this.canvas.height);
        if (this.warpFBO.width !== width || this.warpFBO.height !== height) {
            if (this.warpFBO)
                this.deleteFramebuffer(this.warpFBO);
            this.warpFBO = this.createFramebuffer(width, height, true);
        }
    }
    start() {
        if (this.disposed || this.isPlaying)
            return;
        this.isPlaying = true;
        this.lastFrameTime = performance.now();
        if (this.video) {
            this.video.removeEventListener("pause", this.resumeVideoCallbacks);
            this.requestVideoFrame();
            if (this.videoFramePending) {
                this.videoFramePending = false;
                this.processVideoFrame(this.lastFrameTime, this.video.currentTime);
            }
        }
        this.animationId = requestAnimationFrame(this.renderLoop);
    }
    stop() {
        this.isPlaying = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }
    renderFrame(time) {
        const now = performance.now();
        if (time !== undefined) {
            this.render(time, now);
        }
        else {
            const dt = (now - this.lastFrameTime) / 1000;
            this.lastFrameTime = now;
            this._animationSpeed +=
                (this._targetAnimationSpeed - this._animationSpeed) * 0.05;
            this.accumulatedTime += dt * this._animationSpeed;
            this.render(this.accumulatedTime, now);
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.stop();
        this.unloadVideo();
        const gl = this.gl;
        if (this.retainedVideoFrame)
            this.deleteFramebuffer(this.retainedVideoFrame);
        for (const target of this.sampleTargets)
            this.deleteFramebuffer(target);
        if (this.samplingPrograms) {
            gl.deleteProgram(this.samplingPrograms.downsample);
            gl.deleteProgram(this.samplingPrograms.smoothing);
        }
        this.gl2?.deleteBuffer(this.samplePixelBuffer);
        gl.deleteProgram(this.blurProgram);
        gl.deleteProgram(this.blendProgram);
        gl.deleteProgram(this.tintProgram);
        gl.deleteProgram(this.warpProgram);
        gl.deleteProgram(this.outputProgram);
        gl.deleteBuffer(this.positionBuffer);
        gl.deleteBuffer(this.texCoordBuffer);
        gl.deleteTexture(this.sourceTexture);
        this.deleteFramebuffer(this.blurFBO1);
        this.deleteFramebuffer(this.blurFBO2);
        this.deleteFramebuffer(this.currentAlbumFBO);
        this.deleteFramebuffer(this.nextAlbumFBO);
        this.deleteFramebuffer(this.warpFBO);
    }
    renderLoop = (timestamp) => {
        if (!this.isPlaying)
            return;
        const dt = (timestamp - this.lastFrameTime) / 1000;
        this.lastFrameTime = timestamp;
        this._animationSpeed +=
            (this._targetAnimationSpeed - this._animationSpeed) * 0.05;
        this.accumulatedTime += dt * this._animationSpeed;
        this.render(this.accumulatedTime, timestamp);
        this.animationId = requestAnimationFrame(this.renderLoop);
    };
    /**
     * Main render loop - very efficient!
     * Just: blend album FBOs → domain warp → output
     */
    render(time, timestamp = performance.now()) {
        if (this.disposed || !this.hasImage)
            return;
        this.advanceVideoSmoothing(timestamp);
        const gl = this.gl;
        const width = Math.max(1, this.canvas.width);
        const height = Math.max(1, this.canvas.height);
        if (this.warpFBO.width !== width || this.warpFBO.height !== height) {
            this.deleteFramebuffer(this.warpFBO);
            this.warpFBO = this.createFramebuffer(width, height, true);
        }
        // Calculate transition blend factor
        let blendFactor = 1.0;
        if (this.isTransitioning) {
            // A source can arrive after this frame's timestamp (video frame callbacks
            // run before animation frames); a zero duration must not divide into NaN
            const elapsed = Math.max(0, timestamp - this.transitionStartTime);
            blendFactor =
                this._transitionDuration > 0
                    ? Math.min(1.0, elapsed / this._transitionDuration)
                    : 1.0;
            if (blendFactor >= 1.0) {
                this.isTransitioning = false;
            }
        }
        let currentTexture;
        if (this.isTransitioning && blendFactor < 1.0) {
            gl.useProgram(this.blendProgram);
            this.setupAttributes();
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurFBO1.framebuffer);
            gl.viewport(0, 0, BLUR_SIZE, BLUR_SIZE);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.currentAlbumFBO.texture);
            gl.uniform1i(this.uniforms.blend.texture1, 0);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.nextAlbumFBO.texture);
            gl.uniform1i(this.uniforms.blend.texture2, 1);
            const easedBlend = 0.5 - 0.5 * Math.cos(blendFactor * Math.PI);
            gl.uniform1f(this.uniforms.blend.blend, easedBlend);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            currentTexture = this.blurFBO1.texture;
        }
        else {
            currentTexture = this.nextAlbumFBO.texture;
        }
        // Warp upscales the blended result to full resolution
        gl.useProgram(this.warpProgram);
        this.setupAttributes();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.warpFBO.framebuffer);
        gl.viewport(0, 0, width, height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTexture);
        gl.uniform1i(this.uniforms.warp.texture, 0);
        gl.uniform1f(this.uniforms.warp.time, time);
        gl.uniform1f(this.uniforms.warp.intensity, this._warpIntensity);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        // Output with saturation and dithering
        gl.useProgram(this.outputProgram);
        this.setupAttributes();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.bindTexture(gl.TEXTURE_2D, this.warpFBO.texture);
        gl.uniform1i(this.uniforms.output.texture, 0);
        gl.uniform1f(this.uniforms.output.saturation, this._saturation);
        gl.uniform1f(this.uniforms.output.dithering, this._dithering);
        gl.uniform1f(this.uniforms.output.time, time);
        gl.uniform1f(this.uniforms.output.scale, this._scale);
        gl.uniform2f(this.uniforms.output.resolution, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    setupAttributes() {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.enableVertexAttribArray(this.attribs.position);
        gl.vertexAttribPointer(this.attribs.position, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.enableVertexAttribArray(this.attribs.texCoord);
        gl.vertexAttribPointer(this.attribs.texCoord, 2, gl.FLOAT, false, 0, 0);
    }
    createShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        if (!shader)
            throw new Error("Failed to create shader");
        gl.shaderSource(shader, this.gl2 && type === gl.FRAGMENT_SHADER
            ? `precision highp sampler2D;\n${source}`
            : source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const error = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`Shader compile error: ${error}`);
        }
        return shader;
    }
    createProgram(vertexSource, fragmentSource) {
        const gl = this.gl;
        const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentSource);
        const program = gl.createProgram();
        if (!program)
            throw new Error("Failed to create program");
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const error = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`Program link error: ${error}`);
        }
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        return program;
    }
    createBuffer(data) {
        const gl = this.gl;
        const buffer = gl.createBuffer();
        if (!buffer)
            throw new Error("Failed to create buffer");
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return buffer;
    }
    createTexture() {
        const gl = this.gl;
        const texture = gl.createTexture();
        if (!texture)
            throw new Error("Failed to create texture");
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return texture;
    }
    createFramebuffer(width, height, useHighPrecision = false) {
        if (this.gl2) {
            return this.createSizedFramebuffer(width, height, useHighPrecision && this.halfFloatRenderTargets
                ? this.gl2.RGBA16F
                : this.gl2.RGBA8);
        }
        const gl = this.gl;
        const texture = this.createTexture();
        const canUseHalfFloat = useHighPrecision && this.halfFloatExt && this.halfFloatLinearExt;
        const type = canUseHalfFloat
            ? this.halfFloatExt.HALF_FLOAT_OES
            : gl.UNSIGNED_BYTE;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, type, null);
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer)
            throw new Error("Failed to create framebuffer");
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        return { framebuffer, texture, width, height };
    }
    /**
     * WebGL2 render target with an explicit internal format. Float formats fall
     * back to RGBA8 when the driver reports them incomplete.
     */
    createSizedFramebuffer(width, height, internalFormat) {
        const gl = this.gl2;
        const texture = this.createTexture();
        const pixelType = internalFormat === gl.RGBA32F
            ? gl.FLOAT
            : internalFormat === gl.RGBA16F
                ? gl.HALF_FLOAT
                : gl.UNSIGNED_BYTE;
        if (internalFormat === gl.RGBA32F && !this.floatLinearFiltering) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, pixelType, null);
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer)
            throw new Error("Failed to create framebuffer");
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (internalFormat !== gl.RGBA8 &&
            gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            if (internalFormat === gl.RGBA32F)
                this.float32RenderTargets = false;
            else
                this.halfFloatRenderTargets = false;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        return { framebuffer, texture, width, height };
    }
    applyFloatDrawingBuffer() {
        const gl = this.gl2;
        if (!gl?.drawingBufferStorage || !this.halfFloatRenderTargets)
            return;
        gl.drawingBufferStorage(gl.RGBA16F, Math.max(1, this.canvas.width), Math.max(1, this.canvas.height));
        this._highPrecisionOutput = gl.drawingBufferFormat === gl.RGBA16F;
    }
    deleteFramebuffer(fbo) {
        this.gl.deleteFramebuffer(fbo.framebuffer);
        this.gl.deleteTexture(fbo.texture);
    }
}
return Kawarp;

  })();
  const STYLE_ID = "ym-npv-style";
  const ROOT_ID = "ym-npv";
  const COLLAPSE_KEY = "aurora-npv-collapsed";
  const WIDTH_KEY = "aurora-npv-width";
  const POLL_MS = 800;
  const WIDTH_MIN = 260;
  const WIDTH_MAX = 480;
  const WIDTH_DEFAULT = 300;
  // Collapse the rail when the resize cursor is dragged within this many px of
  // the RIGHT edge of the viewport (covers a classic scrollbar), NOT when the
  // width bottoms out — so you can hold at WIDTH_MIN freely and only collapse
  // by flinging the cursor to the edge (AJ, 2026-10-19).
  const COLLAPSE_EDGE_MARGIN = 20;

  let armed = false;
  let poll = 0;
  let root = null;
  let panel = null;
  let edge = null;
  let resizeHandle = null;
  let artImg = null;
  let titleEl = null;
  let artistEl = null;
  let albumEl = null;
  let metaEl = null; // .ym-npv-meta — the title/byline block, animated on track change
  let lastKey = "";
  let metaPainted = false; // first paint skips the scroll-up delay (rises in instead)
  let collapsed = false;
  let kawarpOn = true; // from the add-on's "Ambient background" setting
  let kawarpOffTimer = 0; // deferred teardown so the fade-out can finish
  let dragState = null;
  // Document-level resize listeners are wired once per page, not once per arm():
  // teardown() does not remove them (they no-op without dragState), so re-arming
  // the snippet would otherwise stack duplicates.
  let resizeWired = false;
  // Kawarp background (video-reactive). See startKawarp().
  let bgCanvas = null;
  let bgKawarp = null;
  let bgVideoEl = null;
  let bgSourceKey = "";
  let bgResizeObserver = null;

  // Lyrics (Phase 2): we do NOT render lyrics here. The live panel that the
  // Synced Lyrics engine builds (#ym-sl-panel) is MOVED into the slot below the
  // hero while the rail is open — same node, same renderer, same sync loop, no
  // second engine. Docking goes through window.YTMod.lyrics.setExternalHost(),
  // a tiny mount hook in the renderer (the same pattern its fullscreen mode
  // already uses): while docked the engine parks the tab-driven visibility
  // state, keeps the render loop running, and stops mountPanel() from
  // reclaiming the node on YTM re-renders. Collapsing/teardown restores the
  // panel to the Lyrics tab.
  let lyricsSlotEl = null;
  let stretchBtnEl = null;
  let goSongBtnEl = null; // "open in song view" button over the hero video
  let queueEl = null;     // "Up Next" section in the rail
  let queueListEl = null;
  let queueToggleEl = null;
  let lyricsDocked = false;
  let lyricsDockRetry = 0;
  let lyricsDockTries = 0;
  let savedLyricsOffset = null; // user's --ym-sl-lyrics-offset while docked
  let savedLyricsScale = null;  // user's --ym-sl-lyrics-scale while docked
  let dockedScaleValue = null;  // the boosted scale currently applied (docked)
  // Video hero (Phase 3): YTM's floating mini player (#movie_player) parked in
  // the art slot while the rail is open off the song view.
  let heldVideo = null;
  let savedVideo = null; // { node, parent, next }
  let floatHostEl = null;       // ytmusic-player#player while hidden by us
  let floatHostPrevVis = "";    // its visibility before we hid it
  // The videoId of the track the held player belongs to. Compared on every
  // updateTrack() so a track change (especially MV → audio) releases the old
  // parked player before findMiniPlayer() can mistake it for the current one.
  let heldVideoId = "";
  // Artist card (Phase 4): fetched per artist channel, cached for the session.
  const artistCache = new Map();
  let artistCardEl = null;
  let artistBannerEl = null;
  let artistNameEl = null;
  let artistMonthlyEl = null;
  let artistSubsEl = null;
  let artistDescEl = null;
  let artistMoreEl = null;
  let artistCurrentId = "";

  /* ---------- tiny DOM helpers (no innerHTML: Trusted Types safe) ---------- */

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value == null) continue;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key === "style") el.style.cssText = value;
        else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2).toLowerCase(), value);
        else el.setAttribute(key, value);
      }
    }
    for (const kid of kids) {
      if (kid == null) continue;
      el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  const NS = "http://www.w3.org/2000/svg";
  function icon(paths, viewBox) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", viewBox || "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const p of paths) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", p);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.9");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
    }
    return svg;
  }

  const ICON_CHEVRON_LEFT = ["M15 6l-6 6 6 6"];
  const ICON_CHEVRON_RIGHT = ["M9 6l6 6-6 6"];
  const ICON_MORE = ["M5 12h.01M12 12h.01M19 12h.01"];

  const ICON_FULLSCREEN = ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"];
  const ICON_FULLSCREEN_EXIT = ["M9 4v5H4", "M15 4v5h5", "M9 20v-5H4", "M15 20v-5h5"];
  function stretchIcon(expanded) {
    return icon(expanded ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN);
  }

  // Share (copy song link) and "open in song view" icons for the NPV header (AJ, 2026-10-19).
  const ICON_SHARE = ["M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5", "M12 16V4", "M8 8l4-4 4 4"];
  const ICON_GO_SONG = ["M15 4h5v5", "M20 4l-8 8", "M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"];

  /* ---------------------------- CSS ---------------------------- */

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
/* Registered so the readability shade INTERPOLATES instead of hard-cutting to
   black every time the 700ms brightness sample lands (AJ, 2026-10-19). */
@property --ym-npv-shade {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}
#${ROOT_ID} {
  position: fixed;
  /* Full-height rail: flush with the very top and the very bottom of the
     window. The nav bar and player bar shift LEFT of the rail (see the DOCK
     rules), so the rail is a true full-height right column. */
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--ym-npv-w, 420px);
  z-index: 2147483000;
  pointer-events: none;
  /* SpicyLyrics webfont (weights 400/500/600/700) for every bit of NPV text:
     the song title, the byline artist, the artist-card name / monthly audience
     / bio, and the show-more button. All of those only set font-weight/size and
     never override family, so setting it here cascades to all of them. Fallbacks
     cover the brief FOUT before the webfont loads. The @font-face itself is
     ensured by ensureSpicyLyricsFont() in injectStyle(). */
  font-family: "SpicyLyrics", "Noto Sans Georgian", "Vazirmatn", "Roboto", "YouTube Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
}
/* Frame = the sliding unit (collapse animation lives here). Inside it, the
   frosted glass is its OWN background layer, separate from the content panel.
   With the frost painted on the content element itself, every repaint of the
   animating lyrics (glow, word transforms, auto-scroll glide) forced Chrome to
   re-run the 36px blur across the whole rail — the dock lagged while the very
   same panel in the Lyrics tab was smooth. As a dedicated layer behind the
   content, the blur is computed once and cached; the lyrics composite on top
   untouched. */
#${ROOT_ID} .ym-npv-frame {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  left: 0;
  pointer-events: none;
  /* Straight black backing behind the card. The band stays a straight vertical
     seam; the card's own rounded corners sit inside it. (A wrapped/curved band
     was tried and reverted — AJ, 2026-10-19.) */
  background: #000;
  box-sizing: border-box;
  /* NO permanent transform here. A transform on the rail's wrapper turns the
     whole lyrics subtree into a composited, coordinate-mapped layer group —
     every per-frame word/glow repaint then re-composites through it. The
     collapse slide below only applies the transform while collapsed. */
  transition: transform .32s cubic-bezier(.22,1,.36,1);
  animation: ym-npv-in .3s cubic-bezier(.22,1,.36,1);
}
#${ROOT_ID}[data-collapsed="true"] .ym-npv-frame { transform: translateX(calc(100% - 10px)); }
/* Seam width: how far the card is inset over the straight black backing.
   Tune the width here; the card keeps its own 14px corners. */
#${ROOT_ID} .ym-npv-frame { --ym-npv-seam: 8px; }
/* Open motion: the rail slides in from the right with a short blur, and its
   content rises in a small stagger. applyCollapsed() replays it on every
   expand — the build-time ym-npv-in only covers the first mount. */
#${ROOT_ID} .ym-npv-frame.ym-npv-opening {
  animation: ym-npv-slide-in .44s cubic-bezier(.32,.72,0,1) both;
}
@keyframes ym-npv-slide-in {
  from { transform: translateX(26px); opacity: 0; filter: blur(7px); }
  to   { transform: none; opacity: 1; filter: blur(0); }
}
#${ROOT_ID} .ym-npv-opening .ym-npv-panel > * {
  animation: ym-npv-rise .48s cubic-bezier(.34,1.4,.5,1) both;
}
#${ROOT_ID} .ym-npv-opening .ym-npv-panel > *:nth-child(2) { animation-delay: .05s; }
#${ROOT_ID} .ym-npv-opening .ym-npv-panel > *:nth-child(3) { animation-delay: .1s; }
#${ROOT_ID} .ym-npv-opening .ym-npv-panel > *:nth-child(4) { animation-delay: .15s; }
#${ROOT_ID} .ym-npv-opening .ym-npv-panel > *:nth-child(5) { animation-delay: .2s; }
@keyframes ym-npv-rise {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: none; }
}
/* Matte black surface (AJ, 2026-10-19). It used to be fully transparent, which
   let page content bleed through on views the rail does not narrow (Library,
   channel pages, etc.) — artist cards and lyrics overlapped. An opaque backdrop
   is page-agnostic: nothing can show under the rail anywhere. */
#${ROOT_ID} .ym-npv-glass {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  /* Inset over the black plate so the plate reads as an 8px seam. */
  left: var(--ym-npv-seam, 8px);
  background: #0a0a0c;
  /* Same radius as the plate: the gap between the two arcs is the band, and it
     curves with the card instead of running straight past the corner. */
  border-radius: 14px 0 0 14px;
  box-shadow: -2px 0 24px rgba(0, 0, 0, 0.28);
  pointer-events: none;
}
/* Kawarp canvas: the video-reactive backdrop. Sits above the matte glass (which
   stays as the opaque fallback if WebGL is unavailable) and below the panel. */
#${ROOT_ID} .ym-npv-bg {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: var(--ym-npv-seam, 8px);
  border-radius: 14px 0 0 14px;
  transition: opacity .3s ease;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}
#${ROOT_ID} .ym-npv-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  left: var(--ym-npv-seam, 8px);
  z-index: 1;
  display: flex;
  flex-direction: column;
  /* Extra top padding (was 16px) so the hover-revealed collapse button and the
     share button at the top never overlap the hero cover art / parked video
     (AJ, 2026-10-19). */
  /* Symmetric 14px. The panel is ALREADY inset 8px by the seam, so the padding
     must match on both sides — a 6px left padding made the content sit 6px from
     the card's left edge but 14px from its right, which read as shifted left
     (AJ, 2026-10-19). */
  padding: 56px 14px 14px;
  /* Match the glass so the content cannot square off the corner the card
     curves away from. */
  border-radius: 14px 0 0 14px;
  /* The rail/page seam is the frame's straight black backing showing through
     the 8px inset — no border here, or it would cut across the rounded corner. */
  box-sizing: border-box;
  color: #fff;
  /* The artist card's SHOW MORE can push the column past the rail height —
     the panel itself scrolls so nothing is ever unreachable. */
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* No visible scrollbar (AJ, 2026-10-19): the rail still scrolls, but the
     6px track read as a second column edge next to YTM's own. */
  scrollbar-width: none;
  -ms-overflow-style: none;
  pointer-events: auto;
}
#${ROOT_ID} .ym-npv-panel::-webkit-scrollbar { width: 0; height: 0; display: none; }
/* YTM's page scrollbar: hidden on the document and on every container YouTube
   uses as a scroller, so it stops reserving a gutter next to the rail (it was
   showing through the seam gap as a second bar). Wheel/keyboard scrolling is
   unaffected (AJ, 2026-10-19). */
html, body,
ytmusic-app, ytmusic-app-layout, #layout, #content, #main-panel,
ytmusic-browse-response, ytmusic-section-list-renderer,
ytmusic-player-page, #tab-renderer {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
html::-webkit-scrollbar, body::-webkit-scrollbar,
ytmusic-app::-webkit-scrollbar, ytmusic-app-layout::-webkit-scrollbar,
#layout::-webkit-scrollbar, #content::-webkit-scrollbar,
#main-panel::-webkit-scrollbar, ytmusic-browse-response::-webkit-scrollbar,
ytmusic-section-list-renderer::-webkit-scrollbar,
ytmusic-player-page::-webkit-scrollbar, #tab-renderer::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
/* Empty state: nothing playing. A centred notice over dimmed content. */
#${ROOT_ID} .ym-npv-empty {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: .45em;
  padding: 24px;
  text-align: center;
  pointer-events: none;
}
#${ROOT_ID}[data-empty="true"] .ym-npv-empty { display: flex; }
#${ROOT_ID}[data-empty="true"] .ym-npv-hero,
#${ROOT_ID}[data-empty="true"] .ym-npv-lyrics,
#${ROOT_ID}[data-empty="true"] .ym-npv-artist,
#${ROOT_ID}[data-empty="true"] .ym-npv-topzone { opacity: .16; }
#${ROOT_ID} .ym-npv-empty-title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -.01em;
}
#${ROOT_ID} .ym-npv-empty-sub {
  font-size: 12.5px;
  color: rgba(255,255,255,.55);
}

@keyframes ym-npv-in {
  from { opacity: 0; scale: .985; }
  to   { opacity: 1; scale: 1; }
}

#${ROOT_ID} .ym-npv-collapse {
  position: absolute;
  top: 8px;
  left: 10px;
  z-index: 3;
  opacity: 0;
  pointer-events: none;
  transition: opacity .2s ease, background .18s ease, color .18s ease, scale .22s cubic-bezier(.34,1.56,.64,1);
}
/* Kawarp on/off now lives in the add-on's Settings (marketplace), not on the
   panel (AJ, 2026-10-19). */
#${ROOT_ID} .ym-npv-topzone {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 52px;
  z-index: 2;
  pointer-events: auto;
}
#${ROOT_ID} .ym-npv-topzone:hover .ym-npv-collapse,
#${ROOT_ID} .ym-npv-collapse:hover,
#${ROOT_ID} .ym-npv-collapse:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
#${ROOT_ID} .ym-npv-collapse:hover { background: rgba(255,255,255,.14); color: #fff; scale: 1.05; }
/* Stretch (fullscreen lyrics) toggle — pinned to the TOP-RIGHT of the panel so
   it can never sit under the collapse chevron, which owns the top-left. */
#${ROOT_ID} .ym-npv-stretch {
  /* Now anchored to .ym-npv-lyrics (it lives inside the lyrics card, AJ 2026-10-19). */
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
}
/* The generic .ym-npv-icon-btn sets display:inline-flex, which beats the UA
   [hidden] rule — without this the stretch toggle stays visible when the rail
   hands the lyrics back to YTM's Lyrics tab. */
#${ROOT_ID} .ym-npv-stretch[hidden] { display: none !important; }
/* Copy-link button — sits at the RIGHT EDGE of the title row, on the title's
   baseline, so it never collides with the top-left collapse chevron.
   Two classes so it outranks the generic .ym-npv-icon-btn 34px box. */
#${ROOT_ID} .ym-npv-icon-btn.ym-npv-share {
  position: absolute;
  top: 50%;
  right: 0;
  transform: translateY(-50%);
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  opacity: .62;
  transition: opacity .18s ease, background .18s ease, scale .2s cubic-bezier(.34,1.56,.64,1);
}
#${ROOT_ID} .ym-npv-icon-btn.ym-npv-share:hover { opacity: 1; }
#${ROOT_ID} .ym-npv-icon-btn.ym-npv-share.ym-npv-copied { opacity: 1; color: #3fe0c5; }
/* "Open in song view" button over the hero video — appears on hover, hidden
   while already on the song view. */
#${ROOT_ID} .ym-npv-go-song {
  position: absolute;
  right: 8px;
  bottom: 8px;
  /* Above the parked #movie_player's own chrome, which otherwise eats the
     click (AJ, 2026-10-19: the button did nothing). */
  z-index: 8;
  pointer-events: auto;
  opacity: 0;
  transition: opacity .2s ease, background .18s ease, scale .22s cubic-bezier(.34,1.56,.64,1);
}
#${ROOT_ID} .ym-npv-art:hover .ym-npv-go-song { opacity: 1; }
#${ROOT_ID} .ym-npv-go-song[hidden] { display: none; }
#${ROOT_ID} .ym-npv-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(255,255,255,.07);
  color: rgba(255,255,255,.85);
  cursor: pointer;
  transition: background .18s ease, color .18s ease, scale .22s cubic-bezier(.34,1.56,.64,1);
}
#${ROOT_ID} .ym-npv-icon-btn:hover { background: rgba(255,255,255,.14); color: #fff; scale: 1.05; }
#${ROOT_ID} .ym-npv-icon-btn:active { scale: .94; }
#${ROOT_ID} .ym-npv-icon-btn svg { width: 18px; height: 18px; display: block; pointer-events: none; }

#${ROOT_ID} .ym-npv-hero {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* No hover shift: moving the hero down on hover pushed the title/artist
     INTO the lyrics below. The collapse button simply reveals over the art. */
}
/* Collapsible wrapper for the hero art. grid-template-rows 1fr -> 0fr animates
   to the element's natural height in BOTH directions, so hiding the art on the
   song view reads as a smooth collapse instead of a snap. */
#${ROOT_ID} .ym-npv-art-slot {
  display: grid;
  grid-template-rows: 1fr;
  justify-items: center;
  width: 100%;
  overflow: hidden;
  transition:
    grid-template-rows .34s cubic-bezier(.22,1,.36,1),
    opacity .26s ease,
    transform .34s cubic-bezier(.22,1,.36,1);
}
#${ROOT_ID} .ym-npv-art-slot > .ym-npv-art { min-height: 0; }
/* Song view: YTM's own player page already owns the video/artwork, so the rail
   shows the title, artist card and queue only (AJ, 2026-10-19). */
#${ROOT_ID}[data-song-view="true"] .ym-npv-art-slot {
  grid-template-rows: 0fr;
  opacity: 0;
  transform: scale(.97);
  pointer-events: none;
}
#${ROOT_ID} .ym-npv-art {
  /* Capped so the rail doesn't run overly tall — the lyrics dock gets the rest. */
  position: relative; /* positioning context for the cover img + parked video */
  width: min(100%, 240px);
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(255,255,255,.06);
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
  align-self: center;
  /* Smooth shape morph when the slot switches between the square cover (1:1)
     and the parked MV (16:9). Driven by the [data-video-hero] rules below: the
     width + aspect-ratio both transition, so the box grows from a 240px square
     into a full-width 16:9 without snapping (AJ, 2026-10-18). */
  transition: aspect-ratio .34s cubic-bezier(.22,1,.36,1),
              width .34s cubic-bezier(.22,1,.36,1);
}
#${ROOT_ID} .ym-npv-art img,
#${ROOT_ID} .ym-npv-art #movie_player {
  position: absolute;
  inset: 0;
  width: 100% !important;
  height: 100% !important;
  /* Crossfade between the cover art and the parked MV: when video-hero is on the
     cover fades out and the player fades in (and vice-versa). The opacity
     transition also gives the MV a soft fade when it is parked / released. */
  transition: opacity .3s ease;
}
#${ROOT_ID} .ym-npv-art img {
  object-fit: cover;
  display: block;
}
#${ROOT_ID} .ym-npv-meta {
  margin-top: 12px;
  min-width: 0;
  width: 100%;
  text-align: center;
  /* Clip the title/byline during the scroll-up swap so the old credit lifts
     cleanly out of view instead of spilling into the gaps above/below. */
  overflow: hidden;
}
#${ROOT_ID} .ym-npv-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -.005em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* BYLINE (the artist name under the title) — NOTE: deliberately NOT
   .ym-npv-artist: that class belongs to the artist CARD further down, and
   reusing it here made the name inherit the card's border/background. */
#${ROOT_ID} .ym-npv-byline {
  margin-top: 3px;
  font-size: 12px;
  font-weight: 500;
  color: rgba(255,255,255,.7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
#${ROOT_ID} .ym-npv-byline:hover { color: #fff; text-decoration: underline; }
#${ROOT_ID} .ym-npv-album { display: none; }
#${ROOT_ID} .ym-npv-title-row {
  /* Full-width row: the title keeps the row's centre, the copy button is pinned
     to the right edge. min-height must clear the 28px button, otherwise the
     meta block's overflow:hidden (used by the credit swap) clips its top
     (AJ, 2026-10-19). */
  position: relative;
  display: flex;
  align-items: center;
  min-height: 28px;
  width: 100%;
  margin: 0;
}
/* Symmetric padding keeps the centred title centred while reserving the right
   side for the button, so long titles never run underneath it. */
#${ROOT_ID} .ym-npv-title-row > .ym-npv-title {
  padding: 0 34px;
  box-sizing: border-box;
}

/* ─── Track-change animations (Phase 5) ─────────────────────────────────────
   Title/byline scroll-up on a track change (Apple-Music style: the old credit
   lifts out upward, the new one rises up into its place), plus the artist CARD
   fade/slide-in when the channel actually changes. Both reuse the fullscreen
   mode's credit-swap pattern (verified there first) but scoped to the rail. */
@keyframes ym-npv-meta-out {
  from { opacity: 1; transform: translateY(0); }
  to   { opacity: 0; transform: translateY(-14px); }
}
@keyframes ym-npv-meta-in {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
#${ROOT_ID} .ym-npv-meta.ym-npv-meta-leaving {
  animation: ym-npv-meta-out .2s cubic-bezier(.4, 0, 1, 1) forwards;
}
#${ROOT_ID} .ym-npv-meta.ym-npv-meta-entering {
  animation: ym-npv-meta-in .28s cubic-bezier(.22, 1, .36, 1) forwards;
}
@keyframes ym-npv-artist-enter {
  from { opacity: 0; transform: translateY(14px) scale(.985); filter: blur(8px); }
  to   { opacity: 1; transform: none; filter: blur(0); }
}
/* Only on channel change: syncArtistCard() already early-returns when the
   browseId is unchanged, so a re-render here always means a new artist. */
#${ROOT_ID} .ym-npv-artist.ym-npv-artist-enter {
  animation: ym-npv-artist-enter .5s cubic-bezier(.32, .72, 0, 1) both;
}
#${ROOT_ID} .ym-npv-artist-enter .ym-npv-artist-info > * {
  animation: ym-npv-artist-rise .5s cubic-bezier(.34, 1.3, .5, 1) both;
}
#${ROOT_ID} .ym-npv-artist-enter .ym-npv-artist-info > *:nth-child(2) { animation-delay: .05s; }
#${ROOT_ID} .ym-npv-artist-enter .ym-npv-artist-info > *:nth-child(3) { animation-delay: .1s; }
#${ROOT_ID} .ym-npv-artist-enter .ym-npv-artist-info > *:nth-child(4) { animation-delay: .14s; }
@keyframes ym-npv-artist-rise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}
/* Exit animation played when the artist card is swapped for a new artist: the
   old card fades/blurs/slips down, then renderArtistCard() swaps content and
   the enter animation (above) brings the new card in. No exit before? The user
   reported only the IN animation existed (AJ, 2026-10-19). */
@keyframes ym-npv-artist-out {
  from { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
  to   { opacity: 0; transform: translateY(10px) scale(.985); filter: blur(6px); }
}
#${ROOT_ID} .ym-npv-artist.ym-npv-artist-out {
  animation: ym-npv-artist-out .26s cubic-bezier(.4, 0, .2, 1) both;
  pointer-events: none;
}

/* ─── Lyrics dock (Phase 2) ───────────────────────────────────────────────
   The slot the live Synced Lyrics panel (#ym-sl-panel) is MOVED into while
   the rail is open. The engine keeps owning everything inside it — we only
   size the slot and keep our own chrome out of the way. */
#${ROOT_ID} .ym-npv-lyrics {
  /* Compact card, NOT a stretch-to-bottom fill: fixed height so it reads as
     a little rounded lyrics box under the hero. */
  flex: 0 0 auto;
  height: 280px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-top: 12px;
  /* No margin-bottom: the artist card already owns its own 12px margin-top, and
     flex margins do not collapse — the old 12px here made the lyrics↔artist gap
     24px while artist↔queue stayed 12px (AJ, 2026-10-19). */
  margin-bottom: 0;
  border-radius: 16px; /* round card, not a square */
  /* No border AND no background tint — on a see-through panel either one
     paints the box's edge as a stray thin line (AJ, 2026-10-18). The renderer
     supplies its own visual surface. */
  overflow: hidden;
  /* THE lag fix (measured, live): contain:strict (size+layout+paint+style)
     scopes every forced layout + recalc caused by the renderer's per-frame
     animation writes to this subtree. Without it, on the home page YTM's own
     :has()-heavy carousel-shelf CSS turns each of the renderer's per-frame
     style/scroll writes into a full-document recalc + layout (traced: 100-400ms
     Layout events, p95 frame 380-570ms, 6600+ ":has()" invalidations per 4s).
     With it: p50 12ms / p95 37ms — as smooth as the Lyrics tab itself. */
  contain: strict;
  /* Card surface: faint on all four sides so the slot reads as a distinct
     rounded card on the transparent rail (AJ, 2026-10-18: "floating without
     a clear card shape" when it was bare). Kept low-alpha so it never reads
     as the old stray-line artifact. */
  /* Dynamic readability shade behind the lyrics: a black wash whose strength is
     driven by --ym-npv-shade (0 on dark Kawarp frames, up to ~0.6 on bright
     ones). Set from the live Kawarp brightness sample (AJ, 2026-10-19). */
  background:
    linear-gradient(rgba(0, 0, 0, var(--ym-npv-shade, 0)), rgba(0, 0, 0, var(--ym-npv-shade, 0))),
    rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  /* Smooth collapse when the slot is empty (song view / collapsed rail /
     pre-mount): the artist card slides up to fill the gap instead of
     leaving a hole. .empty flips height/margins/opacity to 0 — the base
     transition does the rest. */
  transition: height .32s cubic-bezier(.22,1,.36,1),
              margin .32s cubic-bezier(.22,1,.36,1),
              --ym-npv-shade .9s ease,
              border-color .3s ease,
              opacity .28s ease;
  opacity: 1;
}
#${ROOT_ID} .ym-npv-lyrics.empty {
  height: 0 !important;
  min-height: 0 !important;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
  padding: 0 !important;
  /* A 0-height box still paints its border, and contain: strict keeps that
     border box alive even at height 0 — that was the stray 1px line left after
     the panel moved to the Lyrics tab (AJ, 2026-10-19). Kill the border itself,
     not just its colour; opacity still fades the whole card out. */
  border: 0 !important;
  background: none !important;
  box-shadow: none !important;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
/* The docked renderer's scroller is written to every frame by its auto-scroll
   spring; promote it to its own compositor scroll layer (docked only — this
   rule can only match while the panel lives inside the rail). */
#${ROOT_ID} .ym-npv-lyrics .LyricsContent {
  will-change: scroll-position;
}
/* ─── Video hero (Phase 3) ───────────────────────────────────────────────────
   On non-song pages YTM floats the current track's video in a little player
   (#song-video > #movie_player) above the bar. While the rail is open there, we
   MOVE that player into the art slot — the live MV plays where the cover art
   used to be (audio-only tracks keep the static cover). Same park/restore
   pattern the lyrics dock and the fullscreen mode use: the node goes back to
   #song-video on the song view, on collapse, and on track change. CSS-only
   sizing so YTM's own inline sizing is never touched and restoring is clean. */
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art {
  width: 100%; /* full rail width for the video, not the 240px cover cap */
  aspect-ratio: var(--ym-npv-hero-ratio, 16 / 9);
  border-radius: 8px;
}
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art > img { opacity: 0; pointer-events: none; }
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art > #movie_player { opacity: 1; }
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art #movie_player {
  border-radius: 8px;
}
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art #movie_player,
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art #movie_player .html5-video-container,
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art #movie_player video {
  width: 100% !important;
  height: 100% !important;
  left: 0 !important;
  top: 0 !important;
  transform: none !important;
  object-fit: contain;
}
/* The player drags its overlay chrome into the hero: the channel watermark
   (the artist logo, e.g. brakence's umbrella) renders huge at this size, plus
   suggestion badges / card buttons that don't belong in a tiny lyric rail. */
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art .iv-branding,
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art .branding-img,
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art .branding-img-container,
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art .ytp-suggested-action-badge,
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art .ytp-cards-button,
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art .ytp-overflow-button,
#${ROOT_ID}[data-video-hero="true"] .ym-npv-art .ytp-paid-content-overlay {
  display: none !important;
}
/* ─── Artist card (Phase 4) ──────────────────────────────────────────────────
   Spotify-style "About the artist" card at the rail's bottom: the artist's
   channel banner as the cover, name + monthly audience, the bio clamped to two
   lines with a Show more toggle, and a click-through to the channel. Data comes
   from YTM's own innertube browse endpoint (page-world fetch, verified live). */
#${ROOT_ID} .ym-npv-artist {
  flex: 0 0 auto;
  margin-top: 12px;
  border-radius: 16px;
  /* Card surface: same treatment as the lyrics slot so the two read as a
     matched pair of rounded cards. The banner fills the top 120px so the
     background only shows behind the name/listener/desc block. Kept very
     low-alpha so it never reads as a stray line on the transparent rail. */
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  overflow: hidden;
  color: #fff;
  text-align: left;
}
#${ROOT_ID} .ym-npv-artist[hidden] { display: none; }
#${ROOT_ID} .ym-npv-artist-banner {
  height: 120px;
  background-size: cover; /* fill the slot, just a light crop */
  background-repeat: no-repeat;
  background-position: center;
  background-color: rgba(255,255,255,.06);
}
#${ROOT_ID} .ym-npv-artist-info { padding: 10px 12px 12px; }
#${ROOT_ID} .ym-npv-artist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
#${ROOT_ID} .ym-npv-artist-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
  cursor: pointer;
}
#${ROOT_ID} .ym-npv-artist-name:hover { text-decoration: underline; }
#${ROOT_ID} .ym-npv-artist-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin-top: 2px;
}
#${ROOT_ID} .ym-npv-artist-monthly,
#${ROOT_ID} .ym-npv-artist-subs {
  margin-top: 0;
  font-size: 11px;
  color: rgba(255,255,255,.6);
}
#${ROOT_ID} .ym-npv-artist-subs:empty { display: none; }
#${ROOT_ID} .ym-npv-artist-desc {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.45;
  color: rgba(255,255,255,.75);
  /* Collapsed = ~2 lines, clipped by max-height (animatable, unlike
     -webkit-line-clamp). The SHOW MORE click animates max-height to the real
     content height via JS, so the reveal is smooth (AJ, 2026-10-19). */
  display: block;
  overflow: hidden;
  max-height: 35px;
  transition: max-height .3s cubic-bezier(.22,1,.36,1);
}
#${ROOT_ID} .ym-npv-artist-desc.expanded {
  /* Visual/semantic state only; the actual height is driven by the inline
     max-height the click handler sets, so the transition is exact. */
  display: block;
}
#${ROOT_ID} .ym-npv-artist-more {
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: none;
  /* Buttons don't inherit font-family by default, so force SpicyLyrics here
     (AJ, 2026-10-19). */
  font-family: inherit;
  color: rgba(255,255,255,.85);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .02em;
  cursor: pointer;
}
/* Any NPV button inherits the SpicyLyrics family (the artist-card "show more"
   button is the only one with text; the icon buttons are covered too). */
#${ROOT_ID} button { font-family: inherit; }
/* ─── Up Next queue (AJ, 2026-10-19) ─────────────────────────────────────────
   Sits UNDER the artist card and inherits the SpicyLyrics family from #${ROOT_ID}.
   "Open queue" expands the list (smooth height + staggered row fade); "Show more"
   reveals a long queue. */
#${ROOT_ID} .ym-npv-queue {
  flex: 0 0 auto;
  margin-top: 12px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  overflow: hidden;
  color: #fff;
}
#${ROOT_ID} .ym-npv-queue[hidden] { display: none; }
#${ROOT_ID} .ym-npv-queue[data-open="true"] {
  border-color: rgba(63, 224, 197, .16);
  background: rgba(255, 255, 255, .045);
  transition: border-color .3s ease, background .3s ease;
}
/* Lyrics take-over mode hides the artist card; the queue goes with it. */
#${ROOT_ID}[data-lyrics-stretch="true"] .ym-npv-queue { display: none; }
#${ROOT_ID} .ym-npv-queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 12px 6px;
}
#${ROOT_ID} .ym-npv-queue-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .02em;
}
#${ROOT_ID} .ym-npv-queue-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: 1px solid rgba(255, 255, 255, .14);
  border-radius: 999px;
  background: rgba(255, 255, 255, .06);
  color: rgba(255, 255, 255, .85);
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  transition: background .16s ease, color .16s ease, scale .2s cubic-bezier(.34,1.56,.64,1);
}
#${ROOT_ID} .ym-npv-queue-toggle:hover { background: rgba(255, 255, 255, .12); color: #fff; }
#${ROOT_ID} .ym-npv-queue-toggle:active { scale: .96; }
#${ROOT_ID} .ym-npv-queue-toggle[aria-pressed="true"] {
  background: rgba(255, 255, 255, .16);
  color: #fff;
}
#${ROOT_ID} .ym-npv-queue-list {
  list-style: none;
  margin: 0;
  padding: 0 8px 6px;
  overflow: hidden;
  /* Smooth height change when "Open queue" grows / shrinks the list. */
  transition:
    max-height .42s cubic-bezier(.22, 1, .36, 1),
    opacity .13s ease;
}
/* Collapse: fade the old rows out, swap, fade back in. */
#${ROOT_ID} .ym-npv-queue-list.is-swapping { opacity: 0; }
/* Same entrance language as the add-ons panel cards (AJ, 2026-10-19):
   a short lift + micro-scale on a springy curve, staggered via --d. */
#${ROOT_ID} .ym-npv-queue-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 6px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
  transition:
    background .18s ease,
    border-color .18s ease,
    box-shadow .2s ease,
    transform .2s cubic-bezier(.2,.7,.3,1);
}
#${ROOT_ID} .ym-npv-queue-row.is-in {
  /* Fill mode backwards (not both): forwards fill would pin transform and kill
     the hover lift. The keyframe's end state is the natural resting state. */
  animation: ym-npv-qrow-in .38s cubic-bezier(.2,.7,.3,1) backwards;
  animation-delay: var(--d, 0ms);
}
#${ROOT_ID} .ym-npv-queue-row:hover {
  background: rgba(255, 255, 255, .07);
  border-color: rgba(63, 224, 197, .22);
  transform: translateY(-1px);
}
#${ROOT_ID} .ym-npv-queue-row:active { transform: translateY(0) scale(.995); }
@keyframes ym-npv-qrow-in {
  from { opacity: 0; transform: translateY(16px) scale(.985); }
  to   { opacity: 1; transform: none; }
}
#${ROOT_ID} .ym-npv-queue-thumb {
  position: relative;
  width: 40px; height: 40px;
  flex: 0 0 auto;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(255, 255, 255, .08);
}
#${ROOT_ID} .ym-npv-queue-thumb img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
#${ROOT_ID} .ym-npv-queue-play {
  position: absolute;
  inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .4);
  opacity: 0;
  transition: opacity .14s ease;
}
#${ROOT_ID} .ym-npv-queue-play svg { width: 16px; height: 16px; color: #fff; }
#${ROOT_ID} .ym-npv-queue-row:hover .ym-npv-queue-play { opacity: 1; }
#${ROOT_ID} .ym-npv-queue-meta {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
#${ROOT_ID} .ym-npv-queue-name {
  font-size: 12.5px; font-weight: 600;
  line-height: 1.3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${ROOT_ID} .ym-npv-queue-artist {
  font-size: 11px; color: rgba(255, 255, 255, .6);
  line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${ROOT_ID} .ym-npv-queue-more {
  flex: 0 0 auto;
  width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%;
  background: transparent; color: rgba(255, 255, 255, .7);
  cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
#${ROOT_ID} .ym-npv-queue-more:hover { background: rgba(255, 255, 255, .1); color: #fff; }
#${ROOT_ID} .ym-npv-queue-more svg { width: 18px; height: 18px; }
#${ROOT_ID} .ym-npv-queue-showmore {
  width: calc(100% - 16px);
  margin: 2px 8px 8px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: 10px;
  background: rgba(255, 255, 255, .06);
  color: rgba(255, 255, 255, .85);
  font-size: 12px; font-weight: 700;
  cursor: pointer;
  transition:
    background .18s ease,
    border-color .18s ease,
    color .18s ease,
    transform .2s cubic-bezier(.2,.7,.3,1);
}
#${ROOT_ID} .ym-npv-queue-showmore.is-in {
  animation: ym-npv-qmore-in .34s cubic-bezier(.2,.7,.3,1) backwards;
}
#${ROOT_ID} .ym-npv-queue-showmore:hover {
  background: rgba(255, 255, 255, .12);
  border-color: rgba(63, 224, 197, .3);
  color: #fff;
  transform: translateY(-1px);
}
#${ROOT_ID} .ym-npv-queue-showmore:active { transform: translateY(0) scale(.99); }
@keyframes ym-npv-qmore-in {
  from { opacity: 0; transform: translateY(8px) scale(.985); }
  to   { opacity: 1; transform: none; }
}
/* Stretch / take-over mode: hide the hero, let the live lyrics fill the panel. */
#${ROOT_ID}[data-lyrics-stretch="true"] .ym-npv-hero { display: none; }
#${ROOT_ID}[data-lyrics-stretch="true"] .ym-npv-lyrics {
  flex: 1 1 auto;
  height: auto;
  margin-top: 0;
  margin-bottom: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding-top: 36px; /* keep the first line clear of the corner buttons */
}
/* Stretch = lyrics take the whole panel: the artist card goes away too. */
#${ROOT_ID}[data-lyrics-stretch="true"] .ym-npv-artist { display: none; }

/* Collapsed edge: a thin, always-clickable strip at the screen edge. */
#${ROOT_ID} .ym-npv-edge {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 10px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: linear-gradient(90deg, rgba(255,255,255,.16), rgba(255,255,255,.05));
  color: rgba(255,255,255,.75);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity .22s ease, width .22s ease, background .22s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483001;
}
#${ROOT_ID}[data-collapsed="true"] .ym-npv-edge { opacity: 1; pointer-events: auto; }
#${ROOT_ID} .ym-npv-edge:hover { width: 16px; background: linear-gradient(90deg, rgba(255,255,255,.26), rgba(255,255,255,.1)); }
#${ROOT_ID} .ym-npv-edge svg { width: 14px; height: 14px; display: block; pointer-events: none; }

/* DOCKED RAIL — full-height right column. The nav bar, player bar and all
   page content shift LEFT of the rail: the bottom bar (song + controls) ends
   at the rail's left edge instead of sliding under it, and the nav's right
   icons stay clear of the rail's top. */
body.ym-npv-open ytmusic-nav-bar {
  right: var(--ym-npv-w) !important;
  width: auto !important;
}
body.ym-npv-open ytmusic-player-page {
  right: var(--ym-npv-w) !important;
  width: auto !important;
}
body.ym-npv-open ytmusic-player-bar {
  right: var(--ym-npv-w) !important;
  width: auto !important;
}
/* YTM paints the nav + player bar BACKGROUNDS as fixed full-width bands
   (children of ytmusic-app-layout, OUTSIDE the bars themselves). Shifting the
   bars without these leaves the bands' right edge visible through the
   translucent rail. The Dynamic theme adds its own full-width frosted layer
   (.ym-dynamic-bar-blur, fixed 0->viewport with a 1px top border — THE stray
   line at bar level); shift it with the rest. */
body.ym-npv-open #player-bar-background,
body.ym-npv-open #nav-bar-background {
  left: 0 !important;
  right: var(--ym-npv-w) !important;
  width: auto !important;
}
body.ym-npv-open .ym-dynamic-bar-blur {
  right: var(--ym-npv-w) !important;
}
/* The APP-level #content only. A bare id selector also matched the inner
   content divs inside ytmusic-item-thumbnail-overlay-renderer, which are the
   boxes that position each card's play button — narrowing those pushed every
   play triangle to the left, by exactly the rail width. */
body.ym-npv-open ytmusic-app-layout > #content,
body.ym-npv-open #content.style-scope.ytmusic-app {
  width: calc(100% - var(--ym-npv-w)) !important;
}
/* The home feed lives INSIDE #content, which is already narrowed above. Giving
   ytmusic-section-list-renderer its own right margin subtracted the rail width
   a SECOND time, so the feed drifted left and its right edge was clipped — and
   the wider the rail, the worse it got. #content is the only element that
   reserves the space now. */
body.ym-npv-open ytmusic-section-list-renderer {
  width: auto !important;
}

/* Resize handle: a thin strip on the left edge of the rail that the user
   drags to change the panel width (Spotify-style sidebar resize). Always
   slightly visible so the user can find it; brightens on hover/drag. */
#${ROOT_ID} .ym-npv-resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -5px;
  width: 10px;
  cursor: ew-resize;
  z-index: 2;
  /* Hidden by default — no persistent divider bar (AJ, 2026-10-19). The custom
     coloured line only appears on hover/drag, via ::after below. */
  background: transparent;
  border-radius: 5px;
  transition: background .15s ease;
  pointer-events: auto;
  touch-action: none;
}
#${ROOT_ID}[data-collapsed="true"] .ym-npv-resize { display: none; }
/* Custom resize indicator: a thin vertical line with a gradient that fades out
   at the top and bottom. Hidden until you hover/drag the left edge. */
#${ROOT_ID} .ym-npv-resize::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 64%;
  border-radius: 2px;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(90, 209, 255, .85) 22%,
    rgba(90, 209, 255, .85) 78%,
    transparent 100%
  );
  opacity: 0;
  transition: opacity .18s ease;
}
#${ROOT_ID} .ym-npv-resize:hover::after,
#${ROOT_ID} .ym-npv-resize.dragging::after {
  opacity: 1;
}
/* Faint hover wash so the hit zone is discoverable without a permanent bar. */
#${ROOT_ID} .ym-npv-resize:hover,
#${ROOT_ID} .ym-npv-resize.dragging {
  background: rgba(255,255,255,.04);
}
`;
    (document.head || document.documentElement).appendChild(style);
    // Make the SpicyLyrics webfont available on the page (idempotent). Spicy
    // Lyrics itself injects this same stylesheet when it's active, so this is
    // usually a no-op; but it keeps the NPV self-contained if that extension
    // isn't installed or hasn't run yet on this tab. The @font-face declares
    // weights 400/500/600/700, which our text weights (400 monthly+desc, 500
    // byline, 700 title+card-name+show-more) map onto directly.
    if (!document.querySelector('link[href*="spicy-lyrics"]')) {
      const fontLink = document.createElement("link");
      fontLink.rel = "stylesheet";
      fontLink.href = "https://fonts.spikerko.org/spicy-lyrics/source.css";
      (document.head || document.documentElement).appendChild(fontLink);
    }
  }

  /* --------------------------- state --------------------------- */

  function loadState() {
    // ALWAYS start collapsed on page load: the rail is a tool you open, not
    // something that should greet you on every reload (AJ, 2026-10-19). The
    // stored value is still written by applyCollapsed so the collapse can be
    // persisted for future use, but it is deliberately not restored here.
    collapsed = true;
    // The ambient-background preference is owned by the add-on's Settings and
    // arrives over postMessage; start from the documented default until then.
    kawarpOn = true;
  }

  function loadWidth() {
    try {
      const w = parseInt(localStorage.getItem(WIDTH_KEY) || "", 10);
      if (w >= WIDTH_MIN && w <= WIDTH_MAX) return w;
    } catch (e) {}
    return WIDTH_DEFAULT;
  }

  function saveWidth(w) {
    try { localStorage.setItem(WIDTH_KEY, String(w)); } catch (e) {}
  }

  function applyWidth(w) {
    // Hard-clamped to WIDTH_MIN..WIDTH_MAX (limited both ways), and never more
    // than the available space (leave at least 280px for the player page so the
    // video doesn't collapse on narrow viewports).
    const cap = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, (window.innerWidth || 1200) - 280));
    w = Math.max(WIDTH_MIN, Math.min(cap, w));
    document.body.style.setProperty("--ym-npv-w", w + "px");
  }

  function currentVideoId() {
    try { return new URL(location.href).searchParams.get("v") || ""; } catch (e) { return ""; }
  }

  // Bump a YTM thumbnail URL to a higher-res variant. The player-bar img and
  // some YTMod art fields are served at =w60-h60 (the tiny bar thumb). The rail
  // renders the art at up to ~240px square and would look visibly soft. We
  // rewrite =w<NN>-h<NN> or =s<NN> to 720 — high enough to look crisp at 2x
  // DPI, low enough that the browser doesn't waste time on oversize decodes.
  // URLs that are already at or above 720 are left alone.
  function bumpArtQuality(url) {
    if (!url || typeof url !== "string") return url;
    const wMatch = url.match(/=w(\d+)-h(\d+)/);
    if (wMatch) {
      const w = parseInt(wMatch[1], 10);
      if (w < 720) return url.replace(/=w\d+-h\d+/, "=w720-h720");
      return url;
    }
    const sMatch = url.match(/=s(\d+)/);
    if (sMatch) {
      const s = parseInt(sMatch[1], 10);
      if (s < 720) return url.replace(/=s\d+/, "=s720");
      return url;
    }
    return url;
  }

  function readTrack() {
    try {
      const p = window.YTMod && window.YTMod.player;
      const t = p && typeof p.getTrack === "function" ? p.getTrack() : null;
      if (t && t.title) {
        return {
          title: t.title || "",
          artist: t.artist || "",
          album: t.album || "",
          art: bumpArtQuality(t.artworkUrl || ""),
          videoId: t.videoId || currentVideoId(),
        };
      }
    } catch (e) {}
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) return null;
    const pick = (sel) => {
      const el = bar.querySelector(sel);
      return el ? (el.textContent || "").trim() : "";
    };
    const img = bar.querySelector("img");
    return {
      title: pick(".title"),
      artist: pick(".byline"),
      album: "",
      art: bumpArtQuality(img && img.src ? img.src : ""),
      videoId: currentVideoId(),
    };
  }


  /* ---------------------------- lyrics dock (Phase 2) ---------------------- */

  // The song view is the watch page — there the lyrics already live in YTM's
  // Lyrics tab, so the rail must NOT take them. Anywhere else (home, library,
  // search, artist pages…), the open rail owns the lyrics.
  function isSongView() {
    try {
      return /(\/watch([?#]|$)|[?&]v=)/.test(location.pathname + location.search);
    } catch (e) {
      return false;
    }
  }

  // Which of YTM's player-page tabs is selected right now ("lyrics", "up next",
  // "related", "comments", …). Used to decide whether the rail may take the
  // lyrics: on the song view the Lyrics tab already owns them, but every other
  // tab leaves them free for the rail (AJ, 2026-10-19).
  function activePlayerTab() {
    try {
      const bar =
        document.querySelector("ytmusic-player-page tp-yt-paper-tabs") ||
        document.querySelector("tp-yt-paper-tabs");
      if (!bar) return "";
      const sel = bar.querySelector(
        "tp-yt-paper-tab.iron-selected, tp-yt-paper-tab[aria-selected='true']"
      );
      return sel ? (sel.textContent || "").trim().toLowerCase() : "";
    } catch (e) {
      return "";
    }
  }

  function isLyricsTabActive() {
    return activePlayerTab().indexOf("lyrics") !== -1;
  }

  // While docked, the compact box overrides two user settings that are tuned
  // for the tall Lyrics tab: the vertical OFFSET (neutralized so the active
  // line can center — the placement math cancels the transform but the visual
  // shift remains) and the font SCALE (bumped ~20% so the little card reads
  // well). Both are re-asserted here because a change in the options popup
  // re-applies the user's own values.
  function applyDockedLyricsVars() {
    const sc = lyricsSlotEl && lyricsSlotEl.querySelector(".LyricsContent");
    if (!sc) return;
    if (sc.style.getPropertyValue("--ym-sl-lyrics-offset") !== "0px") {
      sc.style.setProperty("--ym-sl-lyrics-offset", "0px");
    }
    // Pin the lyrics to the user's NORMAL scale and re-assert it every tick (and
    // on every resize mousemove). The engine re-applies its own --ym-sl-lyrics-scale
    // on its own cadence, so without this the text can grow as the rail widens.
    // We pin to savedLyricsScale (captured at dock time = the user's setting), not
    // the live value, so the docked size stays constant at any rail width
    // (AJ, 2026-10-19).
    const normal = (savedLyricsScale && savedLyricsScale !== "")
      ? savedLyricsScale
      : (sc.style.getPropertyValue("--ym-sl-lyrics-scale") || "1");
    sc.style.setProperty("--ym-sl-lyrics-scale", normal);
    dockedScaleValue = normal;
  }

// Toggle the .empty class on the lyrics slot: present (panel docked) → full
// 280px box, absent (song view / collapsed / not yet mounted) → smooth
// collapse to 0 so the artist card slides up to fill the gap. Called from
// syncLyricsDock() so it tracks every poll tick AND every SPA navigation.
function updateLyricsSlotEmpty() {
  if (!lyricsSlotEl) return;
  const hasPanel = !!lyricsSlotEl.querySelector(".ym-sl-panel");
  lyricsSlotEl.classList.toggle("empty", !hasPanel);
}

// Single decision point, re-run on collapse changes AND on SPA navigations
// (the 800ms poll) so crossing between the song view and any other page
// moves the panel to the right place automatically.
  // Dynamic readability shade behind the lyrics. Samples the live Kawarp source
  // and washes the lyrics card with black in proportion to how bright the
  // background is — dark frames get nothing, vivid/bright frames get up to ~0.6.
  // Same HSV-value "bright pixel" idea as the fullscreen lyric shade
  // (07-fullscreen-layout.jsfrag). AJ, 2026-10-19.
  let npvShadeBusy = false;
  function updateNpvShade() {
    if (!lyricsSlotEl) return;
    if (collapsed || isSongView()) {
      lyricsSlotEl.style.setProperty("--ym-npv-shade", "0");
      return;
    }
    if (!bgKawarp || npvShadeBusy) return;
    npvShadeBusy = true;
    Promise.resolve(bgKawarp.sampleSource(32))
      .then((pixels) => {
        let shade = 0;
        if (pixels && pixels.length) {
          let bright = 0, count = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
            if (max > 190) bright++;
            count++;
          }
          const response = count ? bright / count : 0;
          shade = Math.max(0, Math.min(1, (response - 0.2) / 0.45)) * 0.6;
        }
        lyricsSlotEl.style.setProperty("--ym-npv-shade", shade.toFixed(3));
      })
      .catch(() => {})
      .finally(() => { npvShadeBusy = false; });
  }
  let npvShadeTimer = null;
  function startNpvShadeLoop() {
    if (npvShadeTimer) return;
    updateNpvShade();
    npvShadeTimer = setInterval(updateNpvShade, 700);
  }

function syncLyricsDock() {
    // ALWAYS first — on the song view this is what RELEASES the parked player
    // back to YTM (the early return below used to skip it, stranding the
    // singleton player in the rail and leaving the watch page empty) and
    // collapses the empty lyrics slot so nothing leaves a hole.
    syncVideoHero();

    const onSongView = isSongView();
    // On the song view the YTM Lyrics tab must show OUR renderer. The panel can
    // only live in one place, so while that tab is active the rail gives it back
    // (with reveal=true) instead of keeping it docked — otherwise the tab falls
    // back to YTM's native lyrics (AJ, 2026-10-19). Every other tab leaves the
    // lyrics free for the rail.
    const ytmLyricsTab = onSongView && isLyricsTabActive();

    if (root) root.dataset.songView = onSongView ? "true" : "false";
    if (stretchBtnEl) stretchBtnEl.hidden = ytmLyricsTab;

    // With the lyrics card empty (Lyrics tab owns the lyrics), the queue can
    // take the freed space and list everything (AJ, 2026-10-19).
    const wantQueueAll = ytmLyricsTab && !collapsed;
    if (wantQueueAll !== queueAll) {
      queueAll = wantQueueAll;
      renderQueue(true);
    }

    if (collapsed) {
      undockLyrics(false);
      updateLyricsSlotEmpty();
      return;
    }
    if (ytmLyricsTab) {
      // Crossfade the handoff instead of snapping the panel between hosts.
      if (lyricsDocked) transferLyricsToTab(true);
      else updateLyricsSlotEmpty();
      return;
    }
    dockLyrics();
    if (lyricsDocked) applyDockedLyricsVars();
    // Resolve the slot AFTER the move so `.empty` lands in the same frame the
    // panel leaves — otherwise the card keeps its border for a poll tick.
    updateLyricsSlotEmpty();
  }

  /* ---- video hero (Phase 3) ----
     YTM floats the current track's video in #song-video > #movie_player while
     you're off the song view. Move that player into the art slot: the live MV
     plays where the cover art was. Same park/restore dance as the lyrics dock —
     sizing is CSS-only so YTM's own inline player sizing is never touched and
     the restore is clean. Audio-only tracks have no sized float, so the static
     cover simply stays. */
  function findMiniPlayer(trackVideoId) {
    if (isSongView()) return null;
    // Prefer the live float wherever it sits. While it is parked in our art
    // slot it is NO LONGER under #song-video — matching the parked node here is
    // what stops the poll from releasing and re-parking it every tick.
    // The heldVideo fallback is trusted whenever the held node is still in the
    // DOM: because updateTrack() releases the held video on EVERY track change
    // (keyed on the cover-art URL, so it fires on non-song pages too), a live
    // heldVideo is always the current track's player. (An explicit videoId
    // comparison is unreliable off the watch page — there the URL has no v=
    // param and currentVideoId() is "", so it can't tell tracks apart.)
    const heldMatches = heldVideo && heldVideo.isConnected;
    let mp =
      document.querySelector("#song-video #movie_player") ||
      document.querySelector("ytmusic-player #movie_player") ||
      (heldMatches ? heldVideo : null);
    if (!mp) return null;
    // One-tick skip: nodes we just released (they're back in #song-video for
    // a beat after a track change) carry a marker so we don't re-park the
    // old MV on top of the new track's cover art. Clear the marker so a
    // future track CAN park it again.
    if (mp.dataset && mp.dataset.ymNpvReleased) {
      try { delete mp.dataset.ymNpvReleased; } catch (e) {}
      return null;
    }
    // A 0-width float means no video for this track (audio-only).
    return mp.getBoundingClientRect().width > 10 || heldMatches ? mp : null;
  }

  function restoreVideo(node) {
    if (!node || node.parentElement !== artImg.parentElement) return;
    // Prefer where it came from. If YTM rebuilt that chain mid-navigation (SPA
    // to the song view tears down the home float), fall back to the CURRENT
    // live float host so the singleton player lands back in place.
    const s = savedVideo && savedVideo.node === node ? savedVideo : null;
    const freshLive = document.querySelector("#song-video #movie_player");
    if (freshLive && freshLive !== node) {
      // YTM already built a replacement player — ours is stale, drop it.
      node.remove();
    } else {
      let target = null;
      let next = null;
      if (s && s.parent && s.parent.isConnected) {
        target = s.parent;
        next = s.next;
      } else {
        target =
          document.querySelector("#song-video #song-media-window") ||
          document.querySelector("#song-video .player-wrapper") ||
          document.querySelector("#song-video");
      }
      if (target) {
        if (next && next.parentElement === target) target.insertBefore(node, next);
        else target.appendChild(node);
      }
    }
    // Mark the released node so findMiniPlayer() skips it for ONE poll — it
    // sits back in #song-video for a tick after a track change, and without
    // the marker the next findMiniPlayer() would mistake it for "the" float
    // and re-park it on top of the new track's cover art.
    try { node.dataset.ymNpvReleased = "1"; } catch (e) {}
    showVideoFloatHost();
    savedVideo = null;
    // Back on the song view the player page may still be laying out; re-fit so
    // the released video cannot keep a rail-sized inline geometry.
    if (isSongView()) reflowPlayer();
  }

  // Hide the mini-player host (ytmusic-player#player — the gray box) while its
  // player is parked in our slot. Live query, NOT closest() on the parked node:
  // by the time we get here the node has already been moved out of the host.
  // Idempotent (dataset marker); remembers the previous visibility so the
  // release restores it exactly.
  function hideVideoFloatHost() {
    if (!heldVideo) return;
    const host = document.querySelector("#player");
    if (!host || host.closest("#ym-npv")) return; // never hide our own rail
    if (host.dataset.ymNpvFloat) return; // already hidden by us
    floatHostEl = host;
    floatHostPrevVis = host.style.visibility || "";
    host.dataset.ymNpvFloat = "1";
    host.style.visibility = "hidden";
  }

  function showVideoFloatHost() {
    const host = floatHostEl;
    floatHostEl = null;
    if (host) {
      delete host.dataset.ymNpvFloat;
      host.style.visibility = floatHostPrevVis || "";
    }
  }

  function syncVideoHero() {
    if (!root) return;
    const want = !collapsed && !isSongView();
    // The track's videoId (not the URL's) is what distinguishes "same track
    // still parked" from "different track, the old MV should be released".
    // On non-song pages the URL has no v= param, so currentVideoId() is ""
    // and can't tell tracks apart — readTrack() gives us the real one
    // (YTMod first, then the player-bar fallback).
    const curTrack = readTrack();
    const curVideoId = curTrack && curTrack.videoId ? curTrack.videoId : "";
    const mp = findMiniPlayer(curVideoId);
    if (want && mp) {
      if (heldVideo && heldVideo !== mp) restoreVideo(heldVideo);
      if (heldVideo !== mp) {
        heldVideo = mp;
        // Stamp the held node with the TRACK it belongs to (not the URL) —
        // this is what lets the next findMiniPlayer() / updateTrack guard
        // tell a stale park from a current one on non-song pages.
        heldVideoId = curVideoId;
        savedVideo = { node: mp, parent: mp.parentElement, next: mp.nextSibling };
        artImg.parentElement.insertBefore(mp, artImg);
      }
      // Hide the float host (the gray empty box) — re-asserted each tick in case
      // a song-view visit already un-hid it.
      hideVideoFloatHost();
      root.dataset.videoHero = "true";
      // Keep the hero at the video's native aspect ratio (16:9 for a typical
      // MV) instead of forcing it into the square cover box.
      const v = mp.querySelector("video");
      const ratio = v && v.videoWidth > 0 ? v.videoWidth / v.videoHeight : 0;
      if (ratio > 0) artImg.parentElement.style.setProperty("--ym-npv-hero-ratio", ratio.toFixed(4));
      return;
    }
    if (heldVideo) {
      restoreVideo(heldVideo);
      heldVideo = null;
      heldVideoId = "";
    }
    if (root.dataset.videoHero) delete root.dataset.videoHero;
    if (artImg && artImg.parentElement) artImg.parentElement.style.removeProperty("--ym-npv-hero-ratio");
  }

  // Move the live Synced Lyrics panel into our slot. The renderer may not have
  // exposed its dock hook yet (scripts load in order, YTMod is built by
  // public-api.js), so poll briefly — but stop after ~10s so an older renderer
  // build can't keep us spinning forever.
  function dockLyrics() {
    if (lyricsDocked || !lyricsSlotEl) return;
    const api = window.YTMod && window.YTMod.lyrics;
    if (!api || typeof api.setExternalHost !== "function") {
      if (!lyricsDockRetry && lyricsDockTries < 25) {
        lyricsDockTries++;
        lyricsDockRetry = window.setTimeout(() => {
          lyricsDockRetry = 0;
          dockLyrics();
        }, 400);
      }
      return;
    }
    if (api.setExternalHost(lyricsSlotEl)) {
      lyricsDocked = true;
      // Park the user's tall-tab lyric settings (vertical offset, then scale),
      // then let the shared docked overrides take over for the compact box.
      const sc = lyricsSlotEl.querySelector(".LyricsContent");
      if (sc) {
        savedLyricsOffset = sc.style.getPropertyValue("--ym-sl-lyrics-offset");
        savedLyricsScale = sc.style.getPropertyValue("--ym-sl-lyrics-scale");
      }
      dockedScaleValue = null;
      applyDockedLyricsVars();
      console.log(TAG, "lyrics panel docked into NPV");
    }
  }

  // Give the panel back to the Lyrics tab (the renderer re-mounts it into
  // #tab-renderer, or holds it on <body> until the watch page returns).
  function undockLyrics(reveal) {
    if (lyricsDockRetry) {
      window.clearTimeout(lyricsDockRetry);
      lyricsDockRetry = 0;
    }
    // A fresh page/context may expose the hook later — retry budget restarts.
    lyricsDockTries = 0;
    if (!lyricsDocked) return;
    const api = window.YTMod && window.YTMod.lyrics;
    if (api && typeof api.setExternalHost === "function") api.setExternalHost(null, reveal === true);
    lyricsDocked = false;
    // Put the user's lyric settings back for the Lyrics tab. The panel is
    // already back under #tab-renderer by now, so query by the panel, not the
    // slot.
    const sc = document.querySelector("#ym-sl-panel .LyricsContent");
    if (sc) {
      if (savedLyricsOffset != null) {
        if (savedLyricsOffset === "") sc.style.removeProperty("--ym-sl-lyrics-offset");
        else sc.style.setProperty("--ym-sl-lyrics-offset", savedLyricsOffset);
      }
      if (savedLyricsScale != null) {
        if (savedLyricsScale === "") sc.style.removeProperty("--ym-sl-lyrics-scale");
        else sc.style.setProperty("--ym-sl-lyrics-scale", savedLyricsScale);
      }
    }
    savedLyricsOffset = null;
    savedLyricsScale = null;
    dockedScaleValue = null;
    console.log(TAG, "lyrics panel returned to the Lyrics tab");
  }

  // Hand the panel back to the Lyrics tab behind a short crossfade. A raw DOM
  // move reads as a glitch: the lyrics vanish from the rail and pop into the
  // tab in the same frame (AJ, 2026-10-19).
  let lyricsTransferBusy = false;
  function transferLyricsToTab(reveal) {
    if (lyricsTransferBusy || !lyricsDocked) return;
    const panel = document.querySelector("#ym-sl-panel");
    if (!panel || !panel.animate) {
      undockLyrics(reveal);
      return;
    }
    lyricsTransferBusy = true;
    let moved = false;
    // Blank the Lyrics tab IMMEDIATELY: YTM renders its own lyrics the moment the
    // tab flips, and our panel only lands ~110ms later, which read as a flash of
    // the native renderer (AJ, 2026-10-19). `ym-sl-panel-active` is the engine's
    // own rule that hides every non-panel child of #tab-renderer; it is removed
    // again by syncNativePanel(false) when the rail docks the lyrics back.
    const tabRenderer = document.querySelector("#tab-renderer");
    if (tabRenderer) tabRenderer.classList.add("ym-sl-panel-active");
    const out = panel.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      { duration: 110, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }
    );
    const finishOut = () => {
      if (moved) return;
      moved = true;
      undockLyrics(reveal);
      updateLyricsSlotEmpty();
      try { out.cancel(); } catch (e) {}
      // The panel now lives in #tab-renderer — fade it back in there.
      requestAnimationFrame(() => {
        if (!panel.isConnected) { lyricsTransferBusy = false; return; }
        const back = panel.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: 170, easing: "cubic-bezier(.22,1,.36,1)" }
        );
        back.onfinish = () => { lyricsTransferBusy = false; };
      });
      window.setTimeout(() => { lyricsTransferBusy = false; }, 260);
    };
    out.onfinish = finishOut;
    window.setTimeout(finishOut, 160);
  }

  function applyLyricsStretch(on) {
    if (!root) return;
    root.setAttribute("data-lyrics-stretch", on ? "true" : "false");
    if (stretchBtnEl) {
      stretchBtnEl.title = on ? "Exit expanded lyrics" : "Expand lyrics";
      stretchBtnEl.setAttribute("aria-label", on ? "Exit expanded lyrics" : "Expand lyrics");
      stretchBtnEl.textContent = "";
      stretchBtnEl.appendChild(stretchIcon(on));
    }
  }

  /* ---- artist card (Phase 4) ---- */

  // The current artist's channel browseId. Primary source: the player bar's
  // byline artist link (verified live: a[href="channel/UC..."]). Fallback: the
  // persistent player's own response.
  function getArtistBrowseId() {
    try {
      const bar = document.querySelector("ytmusic-player-bar");
      if (bar) {
        const a =
          bar.querySelector("a[href*='channel/']") ||
          bar.querySelector("a[href*='/browse/']");
        if (a) {
          const m = String(a.getAttribute("href") || "").match(/(?:channel|browse)\/(UC[A-Za-z0-9_-]{20,})/);
          if (m) return m[1];
        }
      }
      const p = document.querySelector("ytmusic-player");
      const resp = p && typeof p.getPlayerResponse === "function" ? p.getPlayerResponse() : null;
      const v = resp && (resp.videoDetails || {});
      const id = v.channelId || v.ownerChannelId || (resp && resp.microformat && resp.microformat.ownerChannelId);
      if (id && /^UC[A-Za-z0-9_-]{20,}$/.test(id)) return id;
    } catch (e) {}
    return null;
  }

  // YTM's own innertube endpoint, called page-world (same origin — verified
  // live). Defensive: any failure just leaves the card hidden.
  async function fetchArtistInfo(browseId) {
    try {
      const key = getKey();
      if (!key || !browseId) return null;
      const { ok, json } = await ytPost("browse", {
        context: getContext(),
        browseId,
        browseEndpointContextSupportedConfigs: {
          browseEndpointContextMusicConfig: { pageType: "MUSIC_PAGE_TYPE_ARTIST" },
        },
      });
      if (!ok || !json) return null;
      const h = json && json.header && json.header.musicImmersiveHeaderRenderer;
      if (!h) return null;
      const runsText = (o) => {
        if (!o || !Array.isArray(o.runs)) return "";
        let t = "";
        for (const r of o.runs) t += (r && r.text) || "";
        return t.trim();
      };
      const thumbs =
        (h.thumbnail && h.thumbnail.musicThumbnailRenderer && h.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) || [];
      // Largest thumbnail = the channel banner (540x225 .. 1000x416, verified
      // live): the last entry is always the biggest, but filter to be safe.
      let banner = "";
      for (const t of thumbs) if (t && t.url && (t.width || 0) >= 500) banner = t.url;
      // Bio: strip the Wikipedia / source attribution tail.
      const desc = runsText(h.description).replace(/\n\n(?:From Wikipedia|Source:|Provided by|\(c\)|©)[\s\S]*$/i, "").trim();
      const sb = h.subscriptionButton || {};
      const subR = sb.subscribeButtonRenderer || (sb.params ? sb : null);
      // Subscriber count (display only — the subscribe button was removed, AJ 2026-10-19).
      const subs = subR
        ? (subR.subscriberCountText && (subR.subscriberCountText.simpleText || runsText(subR.subscriberCountText))) || ""
        : "";
      return {
        name: runsText(h.title),
        monthly: runsText(h.monthlyListenerCount),
        subs,
        desc,
        banner,
      };
    } catch (e) {
      return null;
    }
  }

  // Open the watch page THROUGH YTM's router. A location.assign() is a real
  // page load: Chrome raises its "Leave site?" beforeunload prompt and the app
  // shell is rebuilt from scratch (AJ, 2026-10-19). Clicking one of YTM's own
  // links routes inside the SPA, so playback and the rail survive.
  function openSongView(id) {
    const selectors = [
      'ytmusic-player-bar a[href*="/watch"]',
      'ytmusic-player-bar a[href*="v="]',
      'ytmusic-player-bar a#thumbnail',
      'ytmusic-player-bar a.thumbnail',
      'ytmusic-player-bar yt-img-shadow a',
      '#song-video a[href*="/watch"]',
    ];
    for (const sel of selectors) {
      const a = document.querySelector(sel);
      if (a && typeof a.click === "function") {
        a.click();
        return true;
      }
    }
    // The title is a yt-formatted-string in newer builds (no anchor). YTM still
    // attaches its own navigation handler to it.
    const title = document.querySelector(
      "ytmusic-player-bar #song-title, ytmusic-player-bar .title"
    );
    if (title && typeof title.click === "function") {
      title.click();
      return true;
    }
    // Any anchor anywhere for THIS video (queue rows, shelves).
    if (id) {
      const a = document.querySelector('a[href*="v=' + id + '"]');
      if (a && typeof a.click === "function") {
        a.click();
        return true;
      }
    }
    return false;
  }

  function navigateToArtistProfile(browseId) {
    if (!browseId) return;
    // YTM is a SPA: a synthetic click on its own channel anchor routes inside
    // the app and playback CONTINUES. (location.assign would reload the page
    // and stop the music.) Fallback: a new tab.
    try {
      const bar = document.querySelector("ytmusic-player-bar");
      const link = bar && bar.querySelector("a[href*='channel/'], a[href*='/browse/']");
      if (link) {
        link.click();
        return;
      }
    } catch (e) {}
    window.open("/channel/" + browseId, "_blank");
  }

  // Shared InnerTube plumbing for the artist-info browse call (AJ, 2026-10-19).
  function getKey() {
    const cfg = window.ytcfg && window.ytcfg.data_;
    let key = cfg && cfg.INNERTUBE_API_KEY;
    if (!key) {
      const m = document.documentElement.innerHTML.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
      key = m && m[1];
    }
    return key || "";
  }
  // Prefer the live INNERTUBE_CONTEXT (correct client version + locale). Without it
  // the browse call can come back with stale/empty artist data.
  function getContext() {
    const cfg = window.ytcfg && window.ytcfg.data_;
    if (cfg && cfg.INNERTUBE_CONTEXT) return cfg.INNERTUBE_CONTEXT;
    return {
      client: { clientName: "WEB_REMIX", clientVersion: "1.20240410.01.00", hl: "en", gl: "US" },
    };
  }
  async function ytPost(path, body) {
    const key = getKey();
    if (!key) return { ok: false, json: null };
    const headers = {
      "Content-Type": "application/json",
      "x-origin": "https://music.youtube.com",
      "X-Goog-AuthUser": "0",
    };
    try {
      const res = await fetch(
        "https://music.youtube.com/youtubei/v1/" + path + "?prettyPrint=false&key=" + encodeURIComponent(key),
        { method: "POST", credentials: "include", headers, body: JSON.stringify(body) }
      );
      if (!res.ok) return { ok: false, json: null };
      let json = null;
      try { json = await res.json(); } catch (e) {}
      return { ok: true, json };
    } catch (e) {
      return { ok: false, json: null };
    }
  }
  function renderArtistCard(info, browseId, opts) {
    if (!artistCardEl) return;
    if (!info || !info.name) {
      artistCardEl.hidden = true;
      return;
    }
    const animate = !opts || opts.animate !== false;
    // Was a different artist already on screen? If so, play the OUT animation
    // first (fade/blur/slip the old card down), then swap content + replay IN.
    const oldId = artistCardEl.dataset.browseId;
    const hasOld = animate && !artistCardEl.hidden && oldId && oldId !== browseId;

    const apply = () => {
      artistBannerEl.style.backgroundImage = info.banner ? 'url("' + info.banner + '")' : "none";
      artistNameEl.textContent = info.name;
      artistMonthlyEl.textContent = info.monthly || "";
      artistMonthlyEl.hidden = !info.monthly;
      // Standalone subscriber-count line (the Subscribe button was removed, AJ 2026-10-19).
      if (artistSubsEl) {
        artistSubsEl.textContent = info.subs || "";
        artistSubsEl.hidden = !info.subs;
      }
      artistDescEl.textContent = info.desc || "";
      artistDescEl.hidden = !info.desc;
      artistMoreEl.hidden = !info.desc;
      artistDescEl.classList.remove("expanded");
      // Clear any inline height/overflow left by a previous expand animation so the
      // new artist starts collapsed at the CSS default.
      artistDescEl.style.maxHeight = "";
      artistDescEl.style.overflow = "";
      artistMoreEl.textContent = "SHOW MORE";
      artistCardEl.hidden = false;
      artistCardEl.dataset.browseId = browseId;
      if (animate) {
        // Restart the rise-in animation by removing the class, forcing reflow, then
        // re-adding it (a no-op re-add won't replay). Drop any leftover OUT class.
        artistCardEl.classList.remove("ym-npv-artist-out");
        artistCardEl.classList.remove("ym-npv-artist-enter");
        void artistCardEl.offsetWidth;
        artistCardEl.classList.add("ym-npv-artist-enter");
      }
    };

    if (hasOld) {
      let done = false;
      const out = () => {
        if (done) return;
        done = true;
        artistCardEl.removeEventListener("animationend", out);
        apply();
      };
      // Listener first, then start the animation, so we never miss animationend.
      artistCardEl.addEventListener("animationend", out, { once: true });
      artistCardEl.classList.add("ym-npv-artist-out");
      setTimeout(out, 300); // fallback in case animationend doesn't fire
    } else {
      apply();
    }
  }

  let artistSwapTimer = 0;
  let artistPendingInfo = null;

  function syncArtistCard() {
    const browseId = getArtistBrowseId();
    if (!browseId || browseId === artistCurrentId) return;
    // Was a card actually on screen? Only then is there something to animate OUT.
    const hadVisibleCard = !!artistCurrentId && !!artistCardEl && !artistCardEl.hidden;
    artistCurrentId = browseId;
    const cached = artistCache.get(browseId);

    const paint = () => {
      const info = artistPendingInfo;
      artistPendingInfo = null;
      // A cached card appears without the IN animation only when it replaced a
      // visible one (the exit already carried the transition).
      if (info) renderArtistCard(info, browseId, { animate: !hadVisibleCard });
      else if (cached) renderArtistCard(cached, browseId, { animate: !hadVisibleCard });
      else artistCardEl.hidden = true;
    };

    if (hadVisibleCard) {
      // Exit FIRST, then swap: previously the new artist replaced the old card
      // in the same frame, so there was no transition at all (AJ, 2026-10-19).
      artistCardEl.classList.remove("ym-npv-artist-enter");
      void artistCardEl.offsetWidth;
      artistCardEl.classList.add("ym-npv-artist-out");
      if (artistSwapTimer) window.clearTimeout(artistSwapTimer);
      artistSwapTimer = window.setTimeout(() => {
        artistSwapTimer = 0;
        artistCardEl.classList.remove("ym-npv-artist-out");
        paint();
      }, 240);
    } else {
      paint();
    }

    // ...but ALWAYS re-fetch the authoritative artist info so the card (banner, bio,
    // monthly listeners, subscriber count) stays current even if the cache is stale.
    fetchArtistInfo(browseId).then((info) => {
      if (!info) return; // network blip — keep whatever is on screen
      artistCache.set(browseId, info);
      if (artistCurrentId !== browseId) return;
      // The exit animation is still running: hand the data to paint() instead
      // of rendering over a card that is on its way out.
      if (artistSwapTimer) {
        artistPendingInfo = info;
        return;
      }
      renderArtistCard(info, browseId, { animate: !cached && !hadVisibleCard });
    });
  }

  /* Our docked rail shrinks ytmusic-player-page, which shrinks #main-panel and
     the #player box. YouTube sizes the <video> from that box but does not always
     catch a container-only resize (only a real viewport resize), so the video can
     keep its old pixel size and overflow — reading as a dark "border" beside it.
     Fix it two ways: (a) directly fit+centre the video to the new box, and
     (b) nudge YouTube with a synthetic window resize so its own handler resyncs.
     (a) is the guarantee; (b) keeps YouTube's internal state correct. Either way
     the video ends up correctly sized — YouTube overwrites these on any real
     resize, so (a) only matters when YouTube stays silent. */
  function fitVideo() {
    try {
      const player = document.querySelector("ytmusic-player-page #player");
      const video = player && player.querySelector("video");
      if (!player || !video) return;
      // Read client size to flush the new layout before measuring.
      const cw = player.clientWidth;
      const ch = player.clientHeight;
      if (!cw || !ch) return;
      const RATIO = 16 / 9;
      let vw, vh;
      if (cw / ch > RATIO) { vh = ch; vw = Math.round(ch * RATIO); }
      else { vw = cw; vh = Math.round(cw / RATIO); }
      video.style.width = vw + "px";
      video.style.height = vh + "px";
      video.style.left = Math.round((cw - vw) / 2) + "px";
      video.style.top = Math.round((ch - vh) / 2) + "px";
      video.style.transform = "none";
    } catch (e) {}
  }

  // Right after a route change the player page is still animating in, so a
  // single fit can latch a stale (tiny) box and leave the video small with
  // black bars until the rail is toggled (AJ, 2026-10-19). Re-fit on the next
  // frames so the last measurement always wins.
  function fitVideoSettled() {
    fitVideo();
    requestAnimationFrame(() => {
      fitVideo();
      window.setTimeout(fitVideo, 120);
      window.setTimeout(fitVideo, 320);
    });
  }

  function reflowPlayer() {
    fitVideoSettled();
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      setTimeout(() => window.dispatchEvent(new Event("resize")), 80);
      setTimeout(() => window.dispatchEvent(new Event("resize")), 220);
    });
  }

  function applyCollapsed() {
    root.dataset.collapsed = String(collapsed);
    document.body.classList.toggle("ym-npv-open", !collapsed);
    edge.setAttribute("aria-expanded", String(!collapsed));
    const frameEl = root.querySelector(".ym-npv-frame");
    if (frameEl) {
      frameEl.classList.remove("ym-npv-opening");
      if (!collapsed) {
        void frameEl.offsetWidth; // restart the animation
        frameEl.classList.add("ym-npv-opening");
      }
    }
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (e) {}
    // Open rail owns the lyrics EXCEPT on the song view; collapsed rail gives
    // them back to the tab.
    syncLyricsDock();
    // Respects the user's Kawarp toggle as well as the collapsed state.
    applyKawarpState();
    reflowPlayer();
  }

  /* Collapse triggered by flinging the cursor to the right edge. Keeps the size
     the rail was at when the gesture fired (held at WIDTH_MIN while dragging past
     the minimum) so re-opening remembers it, instead of snapping back to a
     previously-saved width (AJ, 2026-10-19). */
  function collapseFromResize() {
    if (resizeHandle) resizeHandle.classList.remove("dragging");
    document.body.style.userSelect = "";
    dragState = null;
    const w = parseInt(
      getComputedStyle(document.body).getPropertyValue("--ym-npv-w")
    ) || WIDTH_DEFAULT;
    const clamped = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, w));
    applyWidth(clamped);
    saveWidth(clamped);
    collapsed = true;
    applyCollapsed();
  }

  /* Resize handle — drag the left edge of the rail to change its width.
     Width is hard-clamped to WIDTH_MIN..WIDTH_MAX and persisted in localStorage.
     Flinging the cursor to the right edge of the viewport (within
     COLLAPSE_EDGE_MARGIN) collapses the rail; dragging past the minimum just holds
     at WIDTH_MIN. */
  function setupResize() {
    if (!resizeHandle) return;
    // rAF gate so the live window-resize reflow (below) fires at most once per
    // frame during a drag, not once per mousemove.
    let resizeRaf = 0;
    resizeHandle.addEventListener("mousedown", (e) => {
      const startW = parseInt(
        getComputedStyle(document.body).getPropertyValue("--ym-npv-w")
      ) || WIDTH_DEFAULT;
      dragState = { startX: e.clientX, startW };
      resizeHandle.classList.add("dragging");
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    if (resizeWired) return;
    resizeWired = true;
    document.addEventListener("mousemove", (e) => {
      if (!dragState) return;
      // Collapse ONLY when the cursor reaches the right edge of the viewport —
      // not when the width bottoms out. So dragging past WIDTH_MIN just holds the
      // rail at its minimum (nothing happens) until you fling the cursor to the
      // edge (AJ, 2026-10-19).
      if (e.clientX >= (window.innerWidth || 1200) - COLLAPSE_EDGE_MARGIN) {
        collapseFromResize();
        return;
      }
      const dx = dragState.startX - e.clientX;
      const w = dragState.startW + dx;
      // Normal resize: hard-clamped to WIDTH_MIN..WIDTH_MAX (limited both ways).
      applyWidth(w);
      fitVideo();
      sizeKawarp();
      // Keep the lyrics pinned to their normal size during the drag so the engine's
      // own rescale can't grow them as the rail changes width.
      applyDockedLyricsVars();
      // Fire a synthetic window resize (throttled to one per frame) so YTM's own
      // layout — and the dynamic.js divider between the tabs and the video/art on
      // the watch page — reflows LIVE during the drag instead of only on mouseup
      // (AJ, 2026-10-19).
      if (!resizeRaf) {
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          window.dispatchEvent(new Event("resize"));
        });
      }
    });
    document.addEventListener("mouseup", () => {
      if (!dragState) return;
      resizeHandle.classList.remove("dragging");
      document.body.style.userSelect = "";
      const w = parseInt(
        getComputedStyle(document.body).getPropertyValue("--ym-npv-w")
      ) || WIDTH_DEFAULT;
      // Snap back into the normal range if released past WIDTH_MAX, and never
      // persist a width beyond it.
      const clamped = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, w));
      applyWidth(clamped);
      saveWidth(clamped);
      dragState = null;
      reflowPlayer();
    });
  }

  /* ---- Kawarp background ------------------------------------------------
     Kawarp 1.3.1 (MIT) is inlined above as KawarpClass. It can follow a live
     <video>: frames are sampled into a small colour map, blurred and
     domain-warped, so the rail gets the playing video as an ambient backdrop.
     Audio-only tracks fall back to the cover art. */
  function sizeKawarp() {
    if (!bgCanvas) return;
    const w = Math.max(1, Math.round(bgCanvas.clientWidth || 0));
    const h = Math.max(1, Math.round(bgCanvas.clientHeight || 0));
    if (bgCanvas.width === w && bgCanvas.height === h) return;
    bgCanvas.width = w;
    bgCanvas.height = h;
    if (bgKawarp) {
      try { bgKawarp.resize(); } catch (e) {}
    }
  }

  // Mirror the Aurora blooms settings that dynamic.js applies to the page-wide
  // backdrop, so the rail's Kawarp matches it instead of using hard-coded values
  // (AJ, 2026-10-19). Cheap: only writes when a value actually changed.
  let kawarpApplied = "";
  function syncKawarpSettings() {
    if (!bgKawarp) return;
    const api = window.__ymAuroraDynamic;
    if (!api || typeof api.getSettings !== "function") return;
    let s;
    try { s = api.getSettings(); } catch (e) { return; }
    if (!s) return;
    const sig = [s.warpIntensity, s.blurPasses, s.saturation, s.brightness].join("|");
    if (sig === kawarpApplied) return;
    kawarpApplied = sig;
    try {
      bgKawarp.setOptions({
        warpIntensity: s.warpIntensity,
        blurPasses: s.blurPasses,
        saturation: s.saturation,
      });
    } catch (e) {}
    if (bgCanvas) {
      bgCanvas.style.filter = "saturate(" + s.saturation + ") brightness(" + s.brightness + ")";
    }
  }

  function startKawarp() {
    if (bgKawarp || !bgCanvas || typeof KawarpClass !== "function") return;
    try {
      // Seed from dynamic.js so the first frame already matches the page
      // backdrop; syncKawarpSettings() keeps it in step afterwards.
      const api = window.__ymAuroraDynamic;
      const s = api && typeof api.getSettings === "function" ? api.getSettings() : null;
      bgKawarp = new KawarpClass(bgCanvas, {
        warpIntensity: s ? s.warpIntensity : 1.0,
        blurPasses: s ? s.blurPasses : 6,
        animationSpeed: 0.55,
        transitionDuration: 900,
        saturation: s ? s.saturation : 1.12,
        scale: 1.18,
      });
      bgKawarp.start();
      sizeKawarp();
      syncKawarpSettings();
      updateKawarpSource(true);
      // Built while collapsed: don't burn GPU on an off-screen canvas.
      if (collapsed) { try { bgKawarp.stop(); } catch (e) {} }
    } catch (e) {
      console.warn(TAG, "Kawarp background unavailable", e);
      bgKawarp = null;
    }
  }

  // Reflect `kawarpOn` + collapsed onto the instance and the canvas. Single
  // entry point so the settings listener, the collapse handler and build()
  // cannot disagree about the state.
  //
  // "Off" is a REAL teardown, not a hide: the loop stops, the WebGL context is
  // disposed and the instance is dropped. It fades out first so the removal
  // reads as a transition, then the canvas leaves the layout. Turning it back on
  // recreates the instance and fades the canvas in.
  function applyKawarpState() {
    if (!kawarpOn) {
      // Already fully torn down: nothing to schedule. applyCollapsed() calls
      // this on every toggle, so without the guard we would queue a timer each
      // time.
      if (bgCanvas && bgCanvas.style.display === "none" && !bgKawarp) return;
      if (bgCanvas) bgCanvas.style.opacity = "0"; // CSS transition fades it out
      if (kawarpOffTimer) window.clearTimeout(kawarpOffTimer);
      kawarpOffTimer = window.setTimeout(() => {
        kawarpOffTimer = 0;
        if (kawarpOn) return;
        if (bgKawarp) {
          try { bgKawarp.stop(); } catch (e) {}
          try { bgKawarp.dispose(); } catch (e) {}
          bgKawarp = null;
        }
        if (bgCanvas) bgCanvas.style.display = "none";
      }, 320);
      return;
    }
    if (kawarpOffTimer) { window.clearTimeout(kawarpOffTimer); kawarpOffTimer = 0; }
    if (bgCanvas) {
      bgCanvas.style.display = "";
      // Force a style flush so the opacity transition starts from 0 rather than
      // being coalesced into the display change.
      void bgCanvas.offsetWidth;
      bgCanvas.style.opacity = "1";
    }
    if (!bgKawarp) {
      startKawarp();
      if (collapsed && bgKawarp) { try { bgKawarp.stop(); } catch (e) {} }
      return;
    }
    try {
      if (collapsed) bgKawarp.stop();
      else { bgKawarp.start(); sizeKawarp(); }
    } catch (e) {}
  }

  // Called on every track tick. loadVideo with the same element only re-checks
  // options, so re-asserting is cheap; the cover is only reloaded when the URL
  // changes.
  function updateKawarpSource(force) {
    if (!bgKawarp) return;
    syncKawarpSettings();
    // Dynamic's "Cover art only" toggle applies to the rail's Kawarp too: skip
    // the held video and fall through to the cover image (AJ, 2026-10-20).
    let coverOnly = false;
    try {
      const dyn = window.__ymAuroraDynamic;
      const s = dyn && typeof dyn.getSettings === "function" ? dyn.getSettings() : null;
      coverOnly = !!(s && s.kawarpCoverArtOnly);
    } catch (e) { /* ignore */ }
    const node = !coverOnly && heldVideo && heldVideo.isConnected
      ? heldVideo.querySelector("video")
      : null;
    if (node && node.readyState >= 2) {
      if (force || bgVideoEl !== node) {
        try {
          bgKawarp.loadVideo(node, {
            sampleWidth: 72,
            sampleHeight: 128,
            smoothing: 120,
            frameRate: 30,
          });
          bgVideoEl = node;
          bgSourceKey = "video";
          if (bgCanvas) bgCanvas.dataset.kawarpSrc = "video";
        } catch (e) {}
      }
      if (bgVideoEl === node) return;
    }
    const url = (artImg && (artImg.currentSrc || artImg.src)) || "";
    if (url && (force || bgSourceKey !== url)) {
      bgSourceKey = url;
      bgVideoEl = null;
      if (bgCanvas) bgCanvas.dataset.kawarpSrc = "cover";
      try { bgKawarp.unloadVideo(); } catch (e) {}
      try { bgKawarp.loadImage(url).catch(() => {}); } catch (e) {}
    }
  }

  function build() {
    if (document.getElementById(ROOT_ID)) return;
    injectStyle();

    artImg = h("img", { alt: "", draggable: "false" });
    titleEl = h("div", { class: "ym-npv-title", text: "—" });
    artistEl = h("div", { class: "ym-npv-byline", text: "" });
    artistEl.addEventListener("click", () => navigateToArtistProfile(getArtistBrowseId()));
    albumEl = h("div", { class: "ym-npv-album", text: "" });

    const collapseBtn = h(
      "button",
      { class: "ym-npv-icon-btn ym-npv-collapse", type: "button", title: "Collapse", "aria-label": "Collapse Now Playing" },
      icon(ICON_CHEVRON_RIGHT)
    );
    collapseBtn.addEventListener("click", () => {
      collapsed = true;
      applyCollapsed();
    });

    // Title row: plain centered title (like/dislike buttons removed at AJ's
    // request — they're redundant with YTM's own player bar).
    const titleRow = h("div", { class: "ym-npv-title-row" }, titleEl);

    // Copy-link button: lives at the right edge of the TITLE ROW (AJ, 2026-10-19)
    // and only ever copies — no native share sheet.
    const shareBtn = h(
      "button",
      { class: "ym-npv-icon-btn ym-npv-share", type: "button", title: "Copy link", "aria-label": "Copy song link" },
      icon(ICON_SHARE)
    );
    shareBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const t = readTrack() || {};
      const id = currentVideoId() || t.videoId || "";
      const url = id ? "https://music.youtube.com/watch?v=" + id : location.href;
      const flash = () => {
        shareBtn.classList.add("ym-npv-copied");
        shareBtn.setAttribute("title", "Link copied");
        shareBtn.setAttribute("aria-label", "Link copied");
        setTimeout(() => {
          shareBtn.classList.remove("ym-npv-copied");
          shareBtn.setAttribute("title", "Copy link");
          shareBtn.setAttribute("aria-label", "Copy song link");
        }, 1400);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(flash, () => {});
        }
      } catch (e) {}
    });

    titleRow.appendChild(shareBtn);

    const topZone = h("div", { class: "ym-npv-topzone" }, collapseBtn);

    const stretchBtn = h(
      "button",
      { class: "ym-npv-icon-btn ym-npv-stretch", type: "button", title: "Expand lyrics", "aria-label": "Expand lyrics" },
      stretchIcon(false)
    );
    stretchBtn.addEventListener("click", () => {
      const on = root.getAttribute("data-lyrics-stretch") !== "true";
      applyLyricsStretch(on);
    });
    stretchBtnEl = stretchBtn;

    // "Open in song view" — floats over the hero video; shown when we're NOT
    // already on the watch page (AJ, 2026-10-19).
    const goSongBtn = h(
      "button",
      { class: "ym-npv-icon-btn ym-npv-go-song", type: "button", title: "Open in song view", "aria-label": "Open in song view" },
      icon(ICON_GO_SONG)
    );
    goSongBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      const t = readTrack() || {};
      const id = t.videoId || currentVideoId() || "";
      // In-app routing first — never location.assign (that is what raised the
      // "Leave site?" prompt and reloaded the whole app).
      if (openSongView(id)) return;
      // Nothing clickable (rare): push the SPA route without unloading the page.
      if (id) {
        try {
          history.pushState({}, "", "/watch?v=" + encodeURIComponent(id));
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
        } catch (e) {}
      }
    });
    goSongBtnEl = goSongBtn;

    // Empty slot — the live Synced Lyrics panel (#ym-sl-panel) is moved into
    // it by dockLyrics() when the rail is open on a non-song page. The stretch
    // toggle rides along at its top-right (AJ, 2026-10-19).
    const lyricsSlot = h("div", { class: "ym-npv-lyrics" }, stretchBtn);
    lyricsSlotEl = lyricsSlot;

    // Artist card (Phase 4) — Spotify-style "About the artist", lives at the
    // bottom of the rail under the lyrics box.
    artistBannerEl = h("div", { class: "ym-npv-artist-banner" });
    artistNameEl = h("div", { class: "ym-npv-artist-name", text: "" });
    artistMonthlyEl = h("div", { class: "ym-npv-artist-monthly", text: "" });
    artistSubsEl = h("div", { class: "ym-npv-artist-subs", text: "" });
    artistDescEl = h("div", { class: "ym-npv-artist-desc", text: "" });
    artistMoreEl = h("button", {
      class: "ym-npv-artist-more",
      type: "button",
      text: "SHOW MORE",
    });
    artistMoreEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const expanded = artistDescEl.classList.toggle("expanded");
      if (expanded) {
        // Smoothly reveal: keep it clipped while growing max-height to the real
        // content height, then release the cap so the bio can reflow if the font
        // or layout shifts (AJ, 2026-10-19).
        artistDescEl.style.overflow = "hidden";
        artistDescEl.style.maxHeight = artistDescEl.scrollHeight + "px";
        artistMoreEl.textContent = "SHOW LESS";
        const onEnd = (e) => {
          if (e.propertyName !== "max-height") return;
          if (!artistDescEl.classList.contains("expanded")) return; // collapsed mid-anim
          artistDescEl.style.maxHeight = "none";
          artistDescEl.style.overflow = "visible";
          artistDescEl.removeEventListener("transitionend", onEnd);
        };
        artistDescEl.addEventListener("transitionend", onEnd);
      } else {
        // Collapse: pin to the current (full) height, then animate down to the
        // clamped collapsed height. Keep clipped during the shrink.
        artistDescEl.style.overflow = "hidden";
        artistDescEl.style.maxHeight = artistDescEl.scrollHeight + "px";
        void artistDescEl.offsetWidth; // force reflow so the next change animates
        artistDescEl.style.maxHeight = "35px";
        artistMoreEl.textContent = "SHOW MORE";
      }
    });
    artistNameEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigateToArtistProfile(artistCardEl.dataset.browseId || getArtistBrowseId());
    });
    artistCardEl = h(
      "div",
      { class: "ym-npv-artist", hidden: "true", "aria-label": "About the artist" },
      artistBannerEl,
      h(
        "div",
        { class: "ym-npv-artist-info" },
        h("div", { class: "ym-npv-artist-head" }, artistNameEl),
        h("div", { class: "ym-npv-artist-meta" }, artistMonthlyEl, artistSubsEl),
        artistDescEl,
        artistMoreEl
      )
    );

    // Up Next queue section — UNDER the artist card (AJ, 2026-10-19).
    const queueToggle = h(
      "button",
      { class: "ym-npv-queue-toggle", type: "button", "aria-pressed": "false", title: "Open queue" },
      "Open queue"
    );
    queueToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      queueOpen = !queueOpen;
      // Closing must forget the revealed batches, otherwise the list stays long
      // and the button appears dead (AJ, 2026-10-19).
      if (!queueOpen) queueExtra = 0;
      queueToggle.textContent = queueOpen ? "Close queue" : "Open queue";
      queueToggle.setAttribute("aria-pressed", queueOpen ? "true" : "false");
      queueEl.dataset.open = queueOpen ? "true" : "false";
      renderQueue(true);
    });
    queueToggleEl = queueToggle;

    queueListEl = h("div", { class: "ym-npv-queue-list" });

    queueMoreEl = h(
      "button",
      { class: "ym-npv-queue-showmore", type: "button", text: "Show more" }
    );
    queueMoreEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      queueExtra += 1;
      renderQueue(true);
    });

    queueEl = h(
      "section",
      { class: "ym-npv-queue", hidden: "true", "data-open": "false", "aria-label": "Up next in queue" },
      h("div", { class: "ym-npv-queue-head" },
        h("div", { class: "ym-npv-queue-title", text: "Next in queue" }),
        queueToggle
      ),
      queueListEl,
      queueMoreEl
    );

    panel = h(
      "aside",
      { class: "ym-npv-panel", "aria-label": "Now Playing" },
      topZone,
      h(
        "div",
        { class: "ym-npv-hero" },
        // The art lives in a collapsible grid slot so hiding it on the song
        // view animates the height instead of snapping (AJ, 2026-10-19).
        // artImg's parent MUST stay .ym-npv-art: the video parking code
        // inserts the parked player relative to it.
        h("div", { class: "ym-npv-art-slot" },
          h("div", { class: "ym-npv-art" }, artImg, goSongBtn)
        ),
        (metaEl = h("div", { class: "ym-npv-meta" }, titleRow, artistEl, albumEl))
      ),
      lyricsSlot,
      artistCardEl,
      queueEl,
      h(
        "div",
        { class: "ym-npv-empty" },
        h("div", { class: "ym-npv-empty-title", text: "No track playing" }),
        h("div", { class: "ym-npv-empty-sub", text: "Play a track to get started!" })
      )
    );

    // Glass on its own layer under the content (see the CSS note): keeps the
    // frosted look without re-blurring on every lyrics animation frame.
    const glass = h("div", { class: "ym-npv-glass" });
    bgCanvas = h("canvas", { class: "ym-npv-bg", "aria-hidden": "true" });
    bgCanvas.dataset.kawarp = "loading";
    const frame = h("div", { class: "ym-npv-frame" }, glass, bgCanvas, panel);

    resizeHandle = h("div", {
      class: "ym-npv-resize",
      title: "Drag to resize",
      "aria-label": "Resize Now Playing panel",
      role: "separator",
      "aria-orientation": "vertical"
    });

    edge = h(
      "button",
      { class: "ym-npv-edge", type: "button", title: "Open Now Playing", "aria-label": "Open Now Playing", "aria-expanded": "true" },
      icon(ICON_CHEVRON_LEFT)
    );
    edge.addEventListener("click", () => {
      collapsed = false;
      applyCollapsed();
    });

    root = h("div", { id: ROOT_ID, "data-collapsed": "false" }, frame, resizeHandle, edge);
    (document.body || document.documentElement).appendChild(root);
    setupResize();
    applyCollapsed();

    // Kawarp is inlined, so this is synchronous. The matte glass stays behind
    // it as the fallback if WebGL is unavailable. Skipped entirely when the user
    // has turned the ambient background off.
    if (kawarpOn) startKawarp();
    bgCanvas.dataset.kawarp = bgKawarp ? "running" : "no-webgl";
    applyKawarpState();
    startNpvShadeLoop();
    if (bgResizeObserver) bgResizeObserver.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      bgResizeObserver = new ResizeObserver(() => sizeKawarp());
      bgResizeObserver.observe(bgCanvas);
    }
  }

  function updateTrack() {
    if (!root) return;
    updateQueue();
    if (goSongBtnEl) goSongBtnEl.hidden = isSongView();
    updateNpvShade();
    const track = readTrack();
    if (!track || !track.title) {
      // Nothing playing: the panel shows its own empty state instead of a
      // half-painted rail with stale metadata.
      root.dataset.empty = "true";
      return;
    }
    if (root.dataset.empty) delete root.dataset.empty;
    const key = [track.videoId, track.title, track.artist, track.album, track.art].join("\u0001");
    const trackChanged = key !== lastKey;
    // Release any held video BEFORE syncLyricsDock() can re-park it. We key the
    // release on the TRACK CHANGE itself (detected via the full key, whose art
    // URL is always present) rather than on a videoId comparison. Why: on the
    // home page (and any non-watch page) location.search has no v= param, so
    // currentVideoId() is "" and the heldVideoId we stamp from it is also ""
    // — a videoId comparison can never tell two home-page tracks apart, so the
    // old MV stayed parked (black) behind the new audio track. The cover-art
    // URL differs per track, so this reliably fires on MV → audio, MV → MV, and
    // audio → MV alike. The released node is marked (restoreVideo) so the next
    // findMiniPlayer() won't immediately re-park it on the new cover art.
    if (trackChanged && heldVideo) {
      restoreVideo(heldVideo);
      heldVideo = null;
      heldVideoId = "";
      if (root.dataset.videoHero) delete root.dataset.videoHero;
      if (artImg && artImg.parentElement) artImg.parentElement.style.removeProperty("--ym-npv-hero-ratio");
    }
    // Cheap guards inside — also catches SPA navigations between the song view
    // and other pages so the dock follows the user without a collapse toggle.
    syncLyricsDock();
    updateKawarpSource();
    if (!trackChanged) return;
    lastKey = key;

    // Scroll-up swap for the title/byline: lift the old credit out upward, then
    // paint the new one rising up into its place (Apple-Music style). First
    // paint skips the out-delay and just rises in.
    paintMeta(track);
    if (track.art) {
      artImg.src = track.art;
      artImg.alt = track.album || track.title || "";
    }
    // Lyrics need nothing here: the docked panel is the engine's own node, so
    // it handles track changes (and its loading skeleton) by itself.
    syncArtistCard();
  }

  // Title/byline scroll-up. Splits the swap into an OUT (old lifts up + fades)
  // then a paint + IN (new rises from below). Mirrors the fullscreen mode's
  // credit swap, scoped to the rail. The 200ms out-delay matches the .2s
  // ym-npv-meta-out keyframe so the paint lands exactly as the old text clears.
  function paintMeta(track) {
    const paint = () => {
      titleEl.textContent = track.title || "—";
      artistEl.textContent = track.artist || "";
      albumEl.textContent = track.album || "";
      metaPainted = true;
    };
    if (!metaEl || !metaPainted) {
      paint();
      if (metaEl) {
        metaEl.classList.remove("ym-npv-meta-leaving");
        metaEl.classList.add("ym-npv-meta-entering");
      }
      return;
    }
    metaEl.classList.remove("ym-npv-meta-entering");
    metaEl.classList.add("ym-npv-meta-leaving");
    window.setTimeout(() => {
      if (!metaEl) return;
      paint();
      metaEl.classList.remove("ym-npv-meta-leaving");
      metaEl.classList.add("ym-npv-meta-entering");
    }, 200);
  }

  /* ---- Up Next queue (AJ, 2026-10-19) ------------------------------------
     Reads the live YTM queue model (the same source next-up.js uses) and lists the
     tracks that come AFTER the one currently playing. Sits under the artist card.
     "Open queue" expands it; "Show more" reveals a long queue. */

  // Collapsed always shows the next 5. "Open queue" reveals a batch of 5 plus a
  // "Show more" button, and every press of it adds another batch of 5 — it must
  // NOT jump straight to the whole queue, and closing must reset the batches.
  const QUEUE_DEFAULT = 5;
  const QUEUE_BATCH = 5;

  let queueOpen = false;     // "Open queue" toggle state
  let queueExtra = 0;        // extra batches revealed by "Show more"
  let queueAll = false;      // fill mode: on the Lyrics tab the rail shows the whole queue
  let lastQueueSig = "";     // signature of the rendered upcoming list
  let lastRenderedCount = 0; // rows currently in the list (drives the entrance anim)
  let queueMoreEl = null;    // "Show more" button (assigned in build())
  let queuePaintTimer = 0;   // deferred repaint used by the collapse fade

  // YouTube renderer text: { simpleText } or { runs: [{ text }] }.
  function queueTextOf(node) {
    if (!node) return "";
    if (typeof node.simpleText === "string") return node.simpleText.trim();
    if (Array.isArray(node.runs)) {
      return node.runs.map((r) => (r && r.text) || "").join("").trim();
    }
    return "";
  }
  function queueThumbOf(renderer) {
    const list = renderer && renderer.thumbnail && renderer.thumbnail.thumbnails;
    if (!Array.isArray(list) || !list.length) return "";
    // A ~120px crop: smallest thumb >=120px, else the largest available.
    let best = list[0];
    for (const t of list) {
      const w = t.width || 0;
      const bw = best.width || 0;
      if (w >= 120 && bw < 120) best = t;
      else if (w >= 120 && bw >= 120 && w < bw) best = t;
    }
    return best.url || "";
  }
  // The queue array of playlistPanelVideoRenderer, or null when unreadable.
  function queueRenderers() {
    try {
      const host = document.querySelector("ytmusic-player-queue");
      const data = host && host.data;
      if (!Array.isArray(data) || !data.length) return null;
      const out = data
        .map((entry) => entry && entry.playlistPanelVideoRenderer)
        .filter(Boolean);
      return out.length ? out : null;
    } catch (_) {
      return null;
    }
  }
  // Index of the currently playing row (selected attr, else the live video id).
  function queuePlayingIndex(list) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].selected === true) return i;
    }
    const vid = currentVideoId();
    if (vid) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].videoId === vid) return i;
      }
    }
    return -1;
  }
  // Play a queue track IN PLACE. YTMod.player has no playVideoById, so the old
  // fallback always navigated to the song view. The YouTube player instance
  // (#movie_player) is the API that swaps the video without changing the route.
  function playQueueTrack(id) {
    if (!id) return;
    const moviePlayer =
      document.querySelector("ytmusic-player #movie_player") ||
      document.querySelector("#song-video #movie_player") ||
      document.querySelector("#movie_player");
    if (moviePlayer && typeof moviePlayer.loadVideoById === "function") {
      try { moviePlayer.loadVideoById(id); return; } catch (_) {}
    }
    // Some builds hang the API off ytmusic-player instead.
    const ytmPlayer = document.querySelector("ytmusic-player");
    const api = ytmPlayer && (ytmPlayer.playerApi || ytmPlayer.player_ || null);
    if (api && typeof api.loadVideoById === "function") {
      try { api.loadVideoById(id); return; } catch (_) {}
    }
    if (ytmPlayer && typeof ytmPlayer.playVideoById === "function") {
      try { ytmPlayer.playVideoById(id); return; } catch (_) {}
    }
    // Public bridge, if a future build provides it.
    const bridge = window.YTMod && window.YTMod.player;
    if (bridge && typeof bridge.playVideoById === "function") {
      try { bridge.playVideoById(id); return; } catch (_) {}
    }
    // Native queue row: clicking it uses YTM's own in-place handler.
    const rows = document.querySelectorAll("ytmusic-player-queue-item");
    for (const row of rows) {
      const data = row.data || null;
      const rowId =
        (data && (data.videoId || (data.playlistPanelVideoRenderer && data.playlistPanelVideoRenderer.videoId))) ||
        row.getAttribute("video-id") ||
        "";
      if (rowId === id) { try { row.click(); return; } catch (_) {} }
    }
    // Last resort only: a dead click is worse than the song view.
    location.href = "https://music.youtube.com/watch?v=" + id;
  }

  // (Re)build the queue list. `force` skips the signature short-circuit (used by
  // the toggle / show-more clicks so the entrance animation replays).
  function renderQueue(force) {
    if (!queueEl || !queueListEl || !queueMoreEl) return;
    const list = queueRenderers();
    const upcoming = [];
    if (list) {
      const idx = queuePlayingIndex(list);
      const start = idx >= 0 ? idx + 1 : 0;
      for (let i = start; i < list.length; i++) upcoming.push(list[i]);
    }
    if (!upcoming.length) {
      if (!queueEl.hidden) queueEl.hidden = true;
      lastRenderedCount = 0;
      return;
    }
    queueEl.hidden = false;

    const sig = upcoming.map((r) => r.videoId).join("|");
    if (!force && sig === lastQueueSig) return; // unchanged — don't replay the anim
    // A new track replays the cascade from the top; revealing a batch only
    // animates the rows that just appeared (AJ, 2026-10-19).
    const animateFrom = sig === lastQueueSig ? lastRenderedCount : 0;
    lastQueueSig = sig;

    // Collapsed = next 5. Open = next 5 + a batch of 5 per "Show more" press.
    // On the Lyrics tab the lyrics card is empty, so the queue fills the rail
    // instead of leaving a gap (AJ, 2026-10-19).
    const limit = queueAll
      ? upcoming.length
      : (queueOpen ? QUEUE_DEFAULT + queueExtra * QUEUE_BATCH : QUEUE_DEFAULT);
    const shown = upcoming.slice(0, limit);
    // "Show more" only exists while the queue is open and tracks remain. Resolve
    // it before the (possibly deferred) paint so a collapse hides it immediately.
    const hasMore = !queueAll && queueOpen && limit < upcoming.length;
    queueMoreEl.style.display = hasMore ? "" : "none";

    const paint = () => {
      queueListEl.textContent = "";
      shown.forEach((r, i) => {
        const id = r.videoId;
        const title = queueTextOf(r.title);
        const artist = queueTextOf(r.shortBylineText || r.longBylineText);
        const thumb = queueThumbOf(r);
        const play = h("div", { class: "ym-npv-queue-play" }, icon(["M8 5v14l11-7z"]));
        const thumbWrap = h(
          "div",
          { class: "ym-npv-queue-thumb" },
          thumb ? h("img", { alt: "", src: thumb }) : null,
          play
        );
        const moreBtn = h(
          "button",
          { class: "ym-npv-queue-more", type: "button", title: "More options", "aria-label": "More options" },
          icon(ICON_MORE)
        );
        // "..." currently opens the song view (a hook for a native context menu
        // later); stopPropagation so it doesn't double-fire the row click.
        moreBtn.addEventListener("click", (ev) => { ev.stopPropagation(); playQueueTrack(id); });
        const fresh = i >= animateFrom;
        const row = h(
          "div",
          {
            class: "ym-npv-queue-row" + (fresh ? " is-in" : ""),
            style: fresh ? "--d:" + ((i - animateFrom) * 45) + "ms" : "",
          },
          thumbWrap,
          h(
            "div",
            { class: "ym-npv-queue-meta" },
            h("div", { class: "ym-npv-queue-name", text: title, title: title }),
            h("div", { class: "ym-npv-queue-artist", text: artist, title: artist })
          ),
          moreBtn
        );
        row.addEventListener("click", () => playQueueTrack(id));
        queueListEl.appendChild(row);
      });
      lastRenderedCount = shown.length;

      if (hasMore) {
        queueMoreEl.textContent = "Show more (" + (upcoming.length - shown.length) + ")";
        // Re-trigger the pill's entrance so it reads as newly revealed.
        queueMoreEl.classList.remove("is-in");
        void queueMoreEl.offsetWidth;
        queueMoreEl.classList.add("is-in");
      }

      // Animate the card to its new height once the rows are laid out. +8px
      // buffer absorbs any late webfont swap so a row is never clipped.
      requestAnimationFrame(() => {
        if (!queueListEl) return;
        queueListEl.style.maxHeight = (queueListEl.scrollHeight + 8) + "px";
      });
    };

    // Collapsing drops rows: fade the list out first so the shorter set does not
    // pop in under a container that is still shrinking.
    const shrinking = shown.length < lastRenderedCount && queueListEl.childElementCount > 0;
    if (shrinking) {
      queueListEl.classList.add("is-swapping");
      if (queuePaintTimer) window.clearTimeout(queuePaintTimer);
      queuePaintTimer = window.setTimeout(() => {
        queuePaintTimer = 0;
        paint();
        queueListEl.classList.remove("is-swapping");
      }, 130);
    } else {
      if (queuePaintTimer) { window.clearTimeout(queuePaintTimer); queuePaintTimer = 0; }
      paint();
    }
  }

  // Cheap per-poll refresh; only re-renders when the queue actually changes.
  function updateQueue() {
    renderQueue(false);
  }

  /* -------------------------- lifecycle -------------------------- */

  function arm() {
    if (armed) return;
    armed = true;
    loadState();
    applyWidth(loadWidth());
    build();
    updateTrack();
    poll = window.setInterval(updateTrack, POLL_MS);
    console.log(TAG, "armed");
  }

  function teardown() {
    if (!armed) return;
    armed = false;
    if (poll) { window.clearInterval(poll); poll = 0; }
    if (queuePaintTimer) { window.clearTimeout(queuePaintTimer); queuePaintTimer = 0; }
    if (kawarpOffTimer) { window.clearTimeout(kawarpOffTimer); kawarpOffTimer = 0; }
    if (bgResizeObserver) { bgResizeObserver.disconnect(); bgResizeObserver = null; }
    if (bgKawarp) { try { bgKawarp.dispose(); } catch (e) {} bgKawarp = null; }
    bgCanvas = null;
    bgVideoEl = null;
    bgSourceKey = "";
    // Hand the lyrics panel back BEFORE our slot (its current parent) is removed.
    undockLyrics();
    // Same for the parked mini player.
    if (heldVideo) restoreVideo(heldVideo);
    heldVideo = null;
    savedVideo = null;
    floatHostEl = null;
    floatHostPrevVis = "";
    document.body.classList.remove("ym-npv-open");
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    if (root && root.parentElement) root.parentElement.removeChild(root);
    root = panel = edge = resizeHandle = artImg = titleEl = artistEl = albumEl = lyricsSlotEl = stretchBtnEl = null;
    lyricsDocked = false;
    lyricsDockRetry = 0;
    lyricsDockTries = 0;
    savedLyricsOffset = null;
    savedLyricsScale = null;
    dockedScaleValue = null;
    dragState = null;
    lastKey = "";
    document.body.style.removeProperty("--ym-npv-w");
    console.log(TAG, "torn down");
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.id !== EXT_ID) return;
    if (data.type === "ytmod-settings") {
      // "Ambient background" lives in the add-on's Settings panel; the content
      // script posts the whole settings object whenever it changes.
      const s = data.settings || {};
      const next = s.kawarp === undefined ? true : !!s.kawarp;
      if (next !== kawarpOn) {
        kawarpOn = next;
        applyKawarpState();
      }
      return;
    }
    if (data.type !== "ytmod-ext") return;
    if (data.action === "disable") teardown();
  });

  // Ask for the saved settings BEFORE building, so a disabled ambient
  // background can arrive before the panel is first expanded.
  try { window.postMessage({ type: "ytmod-settings-request", id: EXT_ID }, "*"); } catch (e) {}
  arm();
})();
