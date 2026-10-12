// Shared by the live orb and the offline video generator. One small GPU surface;
// the soft color fields deform in place instead of rotating a painted image.
const vertex = `attribute vec2 position; varying vec2 uv;
void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
const fragment = `precision mediump float;
varying vec2 uv;
uniform float phase;
uniform vec3 cyan;
uniform vec3 violet;
void main(){
  vec2 p=(uv-.5)*2.;
  vec2 q=p;
  q.x+=.18*sin(p.y*2.7+phase)+.07*sin(p.x*3.5-phase*2.);
  q.y+=.15*sin(p.x*2.4-phase)+.06*cos(p.y*3.2+phase*2.);
  float a=q.y+.24+.28*sin(q.x*2.1+phase);
  float b=q.x-.33+.30*sin(q.y*2.3-phase);
  float cool=exp(-a*a*6.)*(.70+.16*sin(q.x*2.5-phase));
  float purple=exp(-b*b*5.)*(.65+.15*cos(q.y*3.+phase));
  vec3 color=vec3(.035,.09,.23);
  color=mix(color,cyan,cool*.42);
  color=mix(color,violet,purple*.34);
  float depth=exp(-dot(q+vec2(.3,-.25),q+vec2(.3,-.25))*1.8);
  color+=vec3(.015,.027,.06)*depth;
  gl_FragColor=vec4(color,1.);
}`;
function createFluidRenderer(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) throw new Error('WebGL unavailable');
  const shaders = [];
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    shaders.push(shader); return shader;
  }
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const time = gl.getUniformLocation(program, 'phase');
  const cool = gl.getUniformLocation(program, 'cyan'), purple = gl.getUniformLocation(program, 'violet');
  gl.viewport(0,0,canvas.width,canvas.height);
  let previousTone = '';
  const colors = {
    on: [[.16,.72,.82],[.40,.28,.75]],
    speaking: [[.14,.75,.68],[.32,.33,.75]],
    capturing: [[.76,.57,.33],[.48,.29,.67]]
  };
  return {
    draw(phase, tone = 'on') {
      if (tone !== previousTone) {
        const palette = colors[tone] || colors.on;
        gl.uniform3fv(cool, palette[0]); gl.uniform3fv(purple, palette[1]);
        previousTone = tone;
      }
      gl.uniform1f(time, phase);
      gl.drawArrays(gl.TRIANGLES,0,6);
    },
    dispose() {
      gl.deleteBuffer(buffer); gl.deleteProgram(program);
      for (const shader of shaders) gl.deleteShader(shader);
    }
  };
}

module.exports = { createFluidRenderer };
