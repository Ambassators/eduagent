"use strict";
/**
 * Deliberately bounded, local math assistant. No eval(), Function(), network,
 * arbitrary code, or silently guessed meanings for unsupported TeX commands.
 * Exact rational arithmetic + one-variable linear/quadratic equations.
 */
const FUNCTIONS = new Set(['sin','cos','tan','asin','acos','atan','sinh','cosh','tanh','ln','log','exp','abs','floor','ceil']);
const GREEK = new Set(['alpha','beta','gamma','delta','epsilon','theta','lambda','mu','nu','xi','rho','sigma','tau','phi','chi','psi','omega']);
const MAX_INPUT = 1200;
const isNum = x => typeof x === 'number' || (x && typeof x === 'object' && !Array.isArray(x) && 'num' in x);
const head = x => Array.isArray(x) ? x[0] : null;
const numericText = x => typeof x === 'number' ? String(x) : x.num;
function fail(message) { throw new Error(message); }

function tokenize(latex) {
  if (typeof latex !== 'string' || latex.length > MAX_INPUT) fail('Expression is too long for automatic calculation.');
  let s = latex.replace(/\\(?:left|right|displaystyle|textstyle|limits|nolimits)\b/g, '')
    .replace(/\\(?:,|;|:|!|quad\b|qquad\b| )/g, ' ')
    .replace(/\\(?:cdot|times)\b/g, '*').replace(/\\div\b/g, '/')
    .replace(/\\(?:lvert|rvert|vert)\b/g, '|').replace(/−/g, '-');
  const out = [];
  for (let i = 0; i < s.length;) {
    if (/\s/.test(s[i])) { i++; continue; }
    const rest = s.slice(i);
    let m;
    if ((m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest))) {
      out.push({ k: 'number', v: m[0] }); i += m[0].length;
    } else if ((m = /^\\([A-Za-z]+)/.exec(rest))) {
      const name = m[1];
      if (name === 'operatorname' || name === 'mathrm' || name === 'mathit') {
        const arg = /^\s*\{([A-Za-z]+)\}/.exec(rest.slice(m[0].length));
        if (!arg) fail('Unsupported named operator.');
        const v = arg[1];
        if (!FUNCTIONS.has(v) && !['e','i'].includes(v)) fail(`Unsupported named operator: ${v}.`);
        out.push({k: FUNCTIONS.has(v) ? 'function' : 'symbol', v});
        i += m[0].length + arg[0].length; continue;
      }
      const aliases = { dfrac:'frac', tfrac:'frac', arctan:'atan', arcsin:'asin', arccos:'acos', lg:'log' };
      const v = aliases[name] || name;
      if (FUNCTIONS.has(v)) out.push({ k: 'function', v });
      else if (['frac','sqrt','sum','pi'].includes(v)) out.push({ k: v, v });
      else if (GREEK.has(v)) out.push({ k: 'symbol', v });
      else fail(`Automatic calculation does not support \\${name}. Your LaTeX remains editable.`);
      i += m[0].length;
    } else if ((m = /^(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|ln|log|exp|abs|floor|ceil)\b/.exec(rest))) {
      out.push({ k: 'function', v: m[1] }); i += m[0].length;
    } else if (/[A-Za-z]/.test(s[i])) {
      out.push({ k: 'symbol', v: s[i++] });
    } else if ('+-*/^_!(){}[]=,|'.includes(s[i])) {
      out.push({ k: s[i], v: s[i] }); i++;
    } else fail(`Automatic calculation does not recognize “${s[i]}”.`);
    if (out.length > 500) fail('Expression has too many terms for automatic calculation.');
  }
  out.push({ k: 'eof', v: '' }); return out;
}

class Parser {
  constructor(tokens) { this.t = tokens; this.i = 0; this.depth = 0; }
  at(k) { return this.t[this.i].k === k; }
  take(k) { if (this.at(k)) return this.t[this.i++]; return null; }
  need(k) { return this.take(k) || fail('Finish the expression to calculate it.'); }
  parse() { const x = this.equal(); this.need('eof'); return x; }
  equal() { let x = this.add(); if (this.take('=')) x = ['Equal', x, this.add()]; return x; }
  add() {
    let x = this.mul();
    while (this.at('+') || this.at('-')) { const k = this.t[this.i++].k; x = [k === '+' ? 'Add' : 'Subtract', x, this.mul()]; }
    return x;
  }
  startsPrimary() { return ['number','symbol','pi','function','frac','sqrt','sum','(','{'].includes(this.t[this.i].k); }
  mul() {
    let x = this.unary();
    while (true) {
      if (this.take('*')) x = ['Multiply', x, this.unary()];
      else if (this.take('/')) x = ['Divide', x, this.unary()];
      else if (this.startsPrimary()) x = ['Multiply', x, this.unary()];
      else return x;
    }
  }
  unary() {
    if (++this.depth > 80) fail('Expression nesting limit exceeded.');
    let x;
    if (this.take('+')) x = this.unary();
    else if (this.take('-')) x = ['Negate', this.unary()];
    else x = this.power();
    this.depth--; return x;
  }
  power() {
    let x = this.primary();
    while (this.take('!')) x = ['Factorial', x];
    if (this.take('^')) x = ['Power', x, this.unary()];
    return x;
  }
  group() {
    if (this.take('{')) { const x = this.equal(); this.need('}'); return x; }
    if (this.take('(')) { const x = this.equal(); this.need(')'); return x; }
    return this.primary();
  }
  primary() {
    let token;
    if ((token = this.take('number'))) return { num: token.v };
    if (this.take('pi')) return 'Pi';
    if ((token = this.take('symbol'))) {
      let name = token.v;
      if (this.take('_')) {
        const sub = this.group();
        if (!isNum(sub) && typeof sub !== 'string') fail('Unsupported subscript in automatic calculation.');
        name += '_' + (isNum(sub) ? numericText(sub) : sub);
      }
      return name === 'e' ? 'ExponentialE' : name === 'i' ? 'ImaginaryUnit' : name;
    }
    if (this.take('{')) { const x = this.equal(); this.need('}'); return x; }
    if (this.take('(')) { const x = this.equal(); this.need(')'); return x; }
    if (this.take('|')) { const x = this.add(); this.need('|'); return ['Abs', x]; }
    if (this.take('frac')) return ['Divide', this.group(), this.group()];
    if (this.take('sqrt')) {
      let root = null;
      if (this.take('[')) { root = this.equal(); this.need(']'); }
      const arg = this.group();
      return root ? ['Root', arg, root] : ['Sqrt', arg];
    }
    if ((token = this.take('function'))) {
      let exponent = null, base = null;
      if (this.take('^')) exponent = this.group();
      if (token.v === 'log' && this.take('_')) base = this.group();
      const arg = (this.at('{') || this.at('(')) ? this.group() : this.unary();
      const names = { sin:'Sin',cos:'Cos',tan:'Tan',asin:'Arcsin',acos:'Arccos',atan:'Arctan',
        sinh:'Sinh',cosh:'Cosh',tanh:'Tanh',ln:'Ln',log:'Log10',exp:'Exp',abs:'Abs',floor:'Floor',ceil:'Ceil' };
      const x = base ? ['Log', arg, base] : [names[token.v], arg];
      return exponent ? ['Power', x, exponent] : x;
    }
    if (this.take('sum')) {
      this.need('_'); const lower = this.group(); this.need('^'); const upper = this.group();
      if (head(lower) !== 'Equal' || typeof lower[1] !== 'string') fail('A finite sum needs a lower bound such as n=1.');
      // A sum binds one multiplicative term; use parentheses for a sum of terms.
      return ['Sum', this.mul(), ['Tuple', lower[1], lower[2], upper]];
    }
    fail('Finish the expression to calculate it.');
  }
}
function parseLatex(latex) { return new Parser(tokenize(latex)).parse(); }

function absBig(n) { return n < 0n ? -n : n; }
function gcd(a,b) { a = absBig(a); b = absBig(b); while (b) [a,b] = [b,a % b]; return a; }
function rat(n, d = 1n) {
  if (!d) fail('Division by zero.');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n,d); n /= g; d /= g;
  if (n.toString().length + d.toString().length > 1200) fail('Exact result exceeds the automatic calculation limit.');
  return { n, d };
}
const R0 = { n:0n, d:1n }, R1 = { n:1n, d:1n };
const addR = (a,b) => rat(a.n*b.d+b.n*a.d,a.d*b.d);
const negR = a => ({ n:-a.n,d:a.d });
const subR = (a,b) => addR(a,negR(b));
const mulR = (a,b) => rat(a.n*b.n,a.d*b.d);
const divR = (a,b) => rat(a.n*b.d,a.d*b.n);
function sqrtBig(n) {
  if (n < 0n) return null;
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2)), y = (x + n/x)/2n;
  while (y < x) { x = y; y = (x+n/x)/2n; }
  return x*x === n ? x : null;
}
function decimalRat(s) {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const exponent = Number(m[4] || 0) - (m[3] || '').length;
  if (Math.abs(exponent) > 300) fail('Exponent exceeds the exact calculation limit.');
  let n = BigInt((m[2] || '0') + (m[3] || '')) * (m[1] === '-' ? -1n : 1n);
  return exponent >= 0 ? rat(n*10n**BigInt(exponent)) : rat(n,10n**BigInt(-exponent));
}
function rationalLatex(r) {
  if (r.d === 1n) return String(r.n);
  return `${r.n < 0n ? '-' : ''}\\frac{${absBig(r.n)}}{${r.d}}`;
}
function exact(ast, env = {}) {
  if (isNum(ast)) return decimalRat(numericText(ast));
  if (typeof ast === 'string') return env[ast] || null;
  const op = head(ast);
  if (!op) return null;
  if (op === 'Sum') {
    const spec = ast[2], lo = exact(spec[2],env), hi = exact(spec[3],env);
    if (!lo || !hi || lo.d !== 1n || hi.d !== 1n || hi.n-lo.n > 5000n) return null;
    let result = R0;
    for (let i = lo.n; i <= hi.n; i++) { const term = exact(ast[1], {...env,[spec[1]]:rat(i)}); if (!term) return null; result = addR(result,term); }
    return result;
  }
  const a = exact(ast[1],env), b = ast.length > 2 ? exact(ast[2],env) : null;
  if (!a) return null;
  switch (op) {
    case 'Add': return b && addR(a,b);
    case 'Subtract': return b && subR(a,b);
    case 'Multiply': return b && mulR(a,b);
    case 'Divide': return b && divR(a,b);
    case 'Negate': return negR(a);
    case 'Abs': return rat(absBig(a.n),a.d);
    case 'Power': {
      if (!b || b.d !== 1n || absBig(b.n) > 100n) return null;
      if (a.n === 0n && b.n === 0n) fail('0^0 is undefined in this calculator.');
      return b.n >= 0n ? rat(a.n**b.n,a.d**b.n) : rat(a.d**(-b.n),a.n**(-b.n));
    }
    case 'Sqrt': {
      const n = sqrtBig(a.n), d = sqrtBig(a.d);
      return n !== null && d !== null ? rat(n,d) : null;
    }
    case 'Factorial': {
      if (a.d !== 1n || a.n < 0n || a.n > 170n) return null;
      let n = 1n; for (let i=2n;i<=a.n;i++) n *= i; return rat(n);
    }
    case 'Sin': case 'Tan': case 'Sinh': case 'Tanh': case 'Arcsin': case 'Arctan':
      return a.n === 0n ? R0 : null;
    case 'Cos': case 'Cosh': case 'Exp': return a.n === 0n ? R1 : null;
    case 'Ln': case 'Log10': return a.n === a.d ? R0 : null;
    case 'Floor': return rat(a.n/a.d - (a.n < 0n && a.n%a.d !== 0n ? 1n : 0n));
    case 'Ceil': return rat(a.n/a.d + (a.n > 0n && a.n%a.d !== 0n ? 1n : 0n));
    default: return null;
  }
}
function numeric(ast, env = {}, angleMode = 'radians') {
  if (isNum(ast)) { const n = Number(numericText(ast)); return Number.isFinite(n) ? n : fail('Number is outside the supported range.'); }
  if (typeof ast === 'string') {
    if (Object.hasOwn(env, ast)) return env[ast];
    if (ast === 'Pi') return Math.PI;
    if (ast === 'ExponentialE') return Math.E;
    fail(`No numeric value is defined for ${ast}.`);
  }
  const op = head(ast);
  if (op === 'Sum') {
    const spec = ast[2], lo = numeric(spec[2],env,angleMode), hi = numeric(spec[3],env,angleMode);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi-lo > 5000) fail('Sum bounds must be integers spanning at most 5,001 terms.');
    let value=0; for(let i=lo;i<=hi;i++) value += numeric(ast[1],{...env,[spec[1]]:i},angleMode);
    return Number.isFinite(value) ? value : fail('Sum overflow.');
  }
  const a = numeric(ast[1],env,angleMode), b = ast.length > 2 ? numeric(ast[2],env,angleMode) : null;
  const angle = angleMode === 'degrees' ? a*Math.PI/180 : a;
  const inverseAngle = angleMode === 'degrees' ? 180/Math.PI : 1;
  let value;
  switch (op) {
    case 'Add': value=a+b; break; case 'Subtract':value=a-b;break;case 'Multiply':value=a*b;break;
    case 'Divide': if(b===0)fail('Division by zero.'); value=a/b;break;
    case 'Negate':value=-a;break;
    case 'Power':if(a===0&&b===0)fail('0^0 is undefined in this calculator.');value=a**b;break;
    case 'Root': value = a < 0 && Number.isInteger(b) && b%2 !== 0 ? -((-a)**(1/b)) : a**(1/b);break;
    case 'Sqrt':value=Math.sqrt(a);break;
    case 'Sin':value=Math.sin(angle);break;case 'Cos':value=Math.cos(angle);break;
    case 'Tan':if(Math.abs(Math.cos(angle))<1e-14)fail('Tangent is undefined at this angle.');value=Math.tan(angle);break;
    case 'Arcsin':value=Math.asin(a)*inverseAngle;break;case 'Arccos':value=Math.acos(a)*inverseAngle;break;case 'Arctan':value=Math.atan(a)*inverseAngle;break;
    case 'Sinh':value=Math.sinh(a);break;case 'Cosh':value=Math.cosh(a);break;case 'Tanh':value=Math.tanh(a);break;
    case 'Ln':value=Math.log(a);break;case 'Log10':value=Math.log10(a);break;case 'Log':value=Math.log(a)/Math.log(b);break;
    case 'Exp':value=Math.exp(a);break;case 'Abs':value=Math.abs(a);break;case 'Floor':value=Math.floor(a);break;case 'Ceil':value=Math.ceil(a);break;
    case 'Factorial':{
      if(!Number.isInteger(a)||a<0||a>170)fail('Factorial needs an integer from 0 to 170.');
      value=1;for(let i=2;i<=a;i++)value*=i;break;
    }
    default:fail('This expression has no supported numeric evaluation.');
  }
  if(!Number.isFinite(value))fail('The result is undefined, non-real, or outside the numeric range.');
  return value;
}
function variables(ast, bound = new Set()) {
  const result = new Set();
  function walk(node, local) {
    if (typeof node === 'string') {
      if (!['Pi','ExponentialE','ImaginaryUnit'].includes(node) && !local.has(node)) result.add(node);
    } else if (Array.isArray(node)) {
      if (node[0] === 'Sum') {
        walk(node[2][2],local);walk(node[2][3],local);
        walk(node[1],new Set([...local,node[2][1]]));
      } else for (const arg of node.slice(1)) walk(arg,local);
    }
  }
  walk(ast,bound); return [...result];
}
function pAdd(a,b) { return a.map((v,i)=>addR(v,b[i])); }
function pMul(a,b) {
  const out=[R0,R0,R0,R0,R0];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)out[i+j]=addR(out[i+j],mulR(a[i],b[j]));
  if(out[3].n||out[4].n)return null;
  return out.slice(0,3);
}
function polynomial(ast, variable) {
  if(ast===variable)return [R0,R1,R0];
  if(!variables(ast).includes(variable)) { const c=exact(ast);return c?[c,R0,R0]:null; }
  const op=head(ast);if(!op)return null;
  const a=polynomial(ast[1],variable),b=ast.length>2?polynomial(ast[2],variable):null;
  if(!a)return null;
  if(op==='Negate')return a.map(negR);
  if(!b)return null;
  if(op==='Add')return pAdd(a,b);
  if(op==='Subtract')return pAdd(a,b.map(negR));
  if(op==='Multiply')return pMul(a,b);
  if(op==='Divide'&&!b[1].n&&!b[2].n)return a.map(v=>divR(v,b[0]));
  if(op==='Power'&&!b[1].n&&!b[2].n&&b[0].d===1n) {
    if(b[0].n===0n)return null; // Do not erase an unknown 0^0 domain.
    if(b[0].n===1n)return a;if(b[0].n===2n)return pMul(a,a);
  }
  return null;
}
function symbolLatex(s) {
  const [name,...sub]=s.split('_');return (GREEK.has(name)?`\\${name}`:name)+(sub.length?`_{${sub.join('_')}}`:'');
}
function factorSquare(n) {
  let outside=1n, inside=n;
  for(let i=2n;i<=1000n&&i*i<=inside;i++)while(inside%(i*i)===0n){inside/=i*i;outside*=i;}
  const rest=sqrtBig(inside);if(rest!==null){outside*=rest;inside=1n;}
  return {outside,inside};
}
function solvePolynomial(equation, variable) {
  if(head(equation)!=='Equal')return null;
  const left=polynomial(equation[1],variable),right=polynomial(equation[2],variable);
  if(!left||!right)return null;
  const p=pAdd(left,right.map(negR)),symbol=symbolLatex(variable);
  if(!p[2].n) {
    if(!p[1].n)return {note:p[0].n?'This equation has no solution.':'This is an identity, true for every value of the variable.',latex:null};
    const root=divR(negR(p[0]),p[1]);
    return {latex:`${symbol}=${rationalLatex(root)}`,roots:[rationalLatex(root)],exact:true,note:'Exact linear solution.'};
  }
  let common=1n;
  for(const v of p)common=common/gcd(common,v.d)*v.d;
  let [c,b,a]=p.map(v=>v.n*(common/v.d));
  const g=gcd(gcd(c,b),a);c/=g;b/=g;a/=g;
  if(a<0n){a=-a;b=-b;c=-c;}
  const d=b*b-4n*a*c,square=sqrtBig(d);
  if(square!==null) {
    let roots=[rat(-b-square,2n*a),rat(-b+square,2n*a)];
    if(square===0n)roots=roots.slice(0,1);
    const labels=roots.map(rationalLatex);
    return {latex:labels.length===1?`${symbol}=${labels[0]}`:`${symbol}\\in\\left\\{${labels.join(',\\,')}\\right\\}`,
      roots:labels,exact:true,note:labels.length===1?'Exact repeated quadratic root.':'Both exact quadratic roots.'};
  }
  const f=factorSquare(absBig(d)),den=2n*a,center=-b,reduce=gcd(gcd(center,f.outside),den);
  const aa=center/reduce,bb=f.outside/reduce,dd=den/reduce;
  const radical=(bb===1n?'':String(bb))+(d<0n?'i':'')+(f.inside===1n?'':`\\sqrt{${f.inside}}`);
  const numerator=(aa===0n?'':String(aa))+'\\pm '+radical;
  const value=dd===1n?numerator:`\\frac{${numerator}}{${dd}}`;
  return {latex:`${symbol}=${value}`,exact:true,note:d<0n?'Both exact complex roots.':'Both exact quadratic roots (±).'};
}

/** Generate code as text only. The app never evaluates or imports this output. */
function javascriptFor(ast, angleMode = 'radians') {
  const vars=variables(ast);
  if(vars.some(v=>! /^[A-Za-z][A-Za-z0-9_]*$/.test(v)))return '// JavaScript export does not support this variable name.';
  function emit(x) {
    if(isNum(x))return String(Number(numericText(x)));
    if(typeof x==='string')return x==='Pi'?'Math.PI':x==='ExponentialE'?'Math.E':x==='ImaginaryUnit'?fail('Complex JavaScript output is not implemented.'):x;
    const op=head(x);
    if(op==='Sum') {
      const spec=x[2],v=spec[1];
      if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(v))fail('Unsupported summation variable.');
      const lo=emit(spec[2]),hi=emit(spec[3]),term=emit(x[1]);
      return `((lo, hi) => { if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi - lo > 5000) throw new RangeError("Invalid sum bounds"); let total = 0; for (let ${v} = lo; ${v} <= hi; ${v}++) total += ${term}; return total; })(${lo}, ${hi})`;
    }
    const a=emit(x[1]),b=x.length>2?emit(x[2]):null;
    if(op==='Factorial')return `((n) => { if (!Number.isInteger(n) || n < 0 || n > 170) throw new RangeError("Invalid factorial"); let r = 1; for (let k = 2; k <= n; k++) r *= k; return r; })(${a})`;
    const operators={Add:'+',Subtract:'-',Multiply:'*',Divide:'/',Power:'**',Equal:'==='};
    if(operators[op])return `(${a} ${operators[op]} ${b})`;
    if(op==='Negate')return `(-${a})`;
    if(op==='Root')return `(${a} < 0 && Number.isInteger(${b}) && ${b} % 2 !== 0 ? -Math.pow(-(${a}), 1 / ${b}) : Math.pow(${a}, 1 / ${b}))`;
    if(op==='Log')return `(Math.log(${a}) / Math.log(${b}))`;
    const f={Sin:'sin',Cos:'cos',Tan:'tan',Arcsin:'asin',Arccos:'acos',Arctan:'atan',Sinh:'sinh',Cosh:'cosh',Tanh:'tanh',Ln:'log',Log10:'log10',Exp:'exp',Abs:'abs',Floor:'floor',Ceil:'ceil',Sqrt:'sqrt'}[op];
    if(f) {
      if(angleMode==='degrees'&&['Sin','Cos','Tan'].includes(op))return `Math.${f}(${a} * Math.PI / 180)`;
      if(angleMode==='degrees'&&['Arcsin','Arccos','Arctan'].includes(op))return `(Math.${f}(${a}) * 180 / Math.PI)`;
      return `Math.${f}(${a})`;
    }
    fail(`JavaScript export is not implemented for ${op}.`);
  }
  try {
    const code=emit(ast);
    return `// Floating-point JavaScript; not an exact-arithmetic guarantee.\nconst expression = (${vars.length?`{ ${vars.join(', ')} }`:''}) => ${code};`;
  } catch(error) { return `// ${error.message}`; }
}
function formattedNumber(value) {
  const str=Number(value.toPrecision(12)).toString();
  if(/[eE]/.test(str)) {const [a,b]=str.split(/[eE]/);return `${a}\\times 10^{${Number(b)}}`;}
  return str;
}
function analyze(latex, options = {}) {
  const original=String(latex).trim(),trailingEquals=/=\s*$/.test(original);
  const clean=trailingEquals?original.replace(/=\s*$/,'').trim():original;
  const angleMode=options.angleMode==='degrees'?'degrees':'radians';
  const result={latex:'',append:'',kind:'none',exact:false,note:'',mathjson:'',javascript:'',replaceTrailingEquals:false};
  if(!clean)return {...result,note:'Type an expression to calculate it.'};
  try {
    const ast=parseLatex(clean);result.mathjson=JSON.stringify(ast,null,2);result.javascript=javascriptFor(ast,angleMode);
    const vars=variables(ast);
    if(head(ast)==='Equal') {
      if(trailingEquals)return {...result,note:'Remove the extra equals sign to solve this equation.'};
      if(vars.length===1) {
        const solved=solvePolynomial(ast,vars[0]);
        if(solved) {
          if(!solved.latex)return {...result,note:solved.note};
          // Do not append x=2 to an equation already in that exact solved form.
          if(ast[1]===vars[0]&&!variables(ast[2]).length)return {...result,note:'This equation is already solved for its variable.'};
          return {...result,...solved,kind:'solve',append:`\\quad\\Longrightarrow\\quad ${solved.latex}`};
        }
      }
      return {...result,note:vars.length>1?'Automatic solving supports one variable at a time.':'Automatic solving supports linear and quadratic equations with rational coefficients.'};
    }
    if(vars.length)return {...result,note:`Enter an equation with = to solve for ${vars.join(', ')}.`};
    if(isNum(ast)&&!trailingEquals)return {...result,note:'Add an operation or type = to calculate.'};
    const value=exact(ast);
    if(value) {
      const answer=rationalLatex(value);
      if(answer.length>240)return {...result,note:'The exact result is too large for an inline suggestion.'};
      return {...result,latex:answer,append:(trailingEquals?'':'=')+answer,kind:'evaluate',exact:true,note:'Exact result.'};
    }
    const n=numeric(ast,{},angleMode),answer=formattedNumber(n);
    return {...result,latex:answer,append:`\\approx ${answer}`,replaceTrailingEquals:trailingEquals,kind:'evaluate',exact:false,
      note:`Numerical approximation, 12 significant digits. Angles: ${angleMode}.`};
  } catch(error) { return {...result,note:error.message || 'No safe automatic result is available.'}; }
}

self.onmessage = event => {
  const {id, latex, revision, options} = event.data;
  self.postMessage({id, latex, revision, result: analyze(latex, options)});
};
