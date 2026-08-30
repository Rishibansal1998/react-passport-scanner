import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreTD3Pair,paddedCrop} from '../.test-build/mrzDetector.js';

const pair=(y=700,x=80,w=860)=>[
 {x,y,width:w,height:24,density:.13,transitions:15},
 {x:x+2,y:y+34,width:w-3,height:24,density:.14,transitions:16}
];
const score=(p,h=1000)=>scoreTD3Pair(p[0],p[1],1000,h);

test('MRZ near bottom scores structurally',()=>assert.ok(score(pair()).confidence>.7));
test('MRZ above bottom is still detected',()=>assert.ok(score(pair(160)).confidence>.7));
test('MRZ in middle is still detected',()=>assert.ok(score(pair(450)).confidence>.7));
test('lower position has low influence',()=>assert.ok(Math.abs(score(pair(100)).confidence-score(pair(800)).confidence)<.08));
test('two matching lines score highly',()=>assert.equal(score(pair()).features.lineCountScore,1));
test('close line spacing is preferred',()=>assert.ok(score(pair()).confidence>score([{...pair()[0]},{...pair()[1],y:180}]).confidence));
test('aligned lines are preferred',()=>assert.ok(score(pair()).confidence>score([{...pair()[0]},{...pair()[1],x:500}]).confidence));
test('similar line widths are preferred',()=>assert.ok(score(pair()).confidence>score([{...pair()[0]},{...pair()[1],width:300}]).confidence));
test('dense character-like bands are preferred',()=>{
 const sparse=pair().map(x=>({...x,density:.02,transitions:1}));
 assert.ok(score(pair()).confidence>score(sparse).confidence);
});
test('candidate does not require P<',()=>assert.equal(score(pair()).features.pLessThanScore,0));
test('crop contains both TD3 lines',()=>{
 const c=paddedCrop(score(pair()).boundingBox,1000,1000);
 assert.ok(c.y<=700&&c.y+c.height>=758);
});
test('crop clamps to image bounds',()=>assert.deepEqual(
 paddedCrop({x:0,y:0,width:30,height:20},100,100),
 {x:0,y:0,width:38,height:28}
));
