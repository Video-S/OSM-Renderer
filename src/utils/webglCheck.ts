export interface WebGLSupportStatus {
  supported: boolean;
  version: 'webgl2' | 'webgl1' | 'none';
  isSoftwareGl: boolean;
  errorMessage?: string;
}

export function detectWebGLSupport(): WebGLSupportStatus {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return {
      supported: false,
      version: 'none',
      isSoftwareGl: true,
      errorMessage: 'Window or document not available',
    };
  }

  // Allow explicit testing or forced fallback mode via URL parameter
  if (window.location && (window.location.search.includes('force2d=1') || window.location.search.includes('noWebGL=1'))) {
    return {
      supported: false,
      version: 'none',
      isSoftwareGl: true,
      errorMessage: 'WebGL disabled via URL parameter (2D Canvas fallback mode).',
    };
  }

  try {
    const canvas = document.createElement('canvas');

    // Try WebGL2 first
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
    let version: 'webgl2' | 'webgl1' | 'none' = 'none';

    try {
      gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
      if (gl) version = 'webgl2';
    } catch {
      // Ignore webgl2 failure and try webgl1
    }

    if (!gl) {
      try {
        gl = (canvas.getContext('webgl') ||
          canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
        if (gl) version = 'webgl1';
      } catch {
        // WebGL unsupported
      }
    }

    if (!gl) {
      return {
        supported: false,
        version: 'none',
        isSoftwareGl: true,
        errorMessage: 'WebGL is disabled or unsupported in this browser environment.',
      };
    }

    // Detect software rendering without destroying context
    let isSoftwareGl = false;
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      isSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    } catch {
      isSoftwareGl = false;
    }

    return {
      supported: true,
      version,
      isSoftwareGl,
    };
  } catch (err: any) {
    return {
      supported: false,
      version: 'none',
      isSoftwareGl: true,
      errorMessage: err?.message || 'Error initializing WebGL context',
    };
  }
}
