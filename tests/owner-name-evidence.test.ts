import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualitySources } from '../src/recognition/qualitySources';
import { recoverOwnerNames } from '../src/recognition/ownerNameEvidence';
import type { AssembledRow, AssemblyIssue } from '../src/recognition/sourceAssembly';
import type { IndependentPage } from '../src/recognition/independentComparison';

const account = '001234567890';
const row = (name = ''): AssembledRow => ({ id: 'T1', values: [account, name, ...Array(10).fill('')], sourceRows: [1], fields: Array.from({length:12},()=>[]) });
const page = (name = '测试甲', number = account): IndependentPage => ({ pageType: 'transactions', coverage: 'complete', pageIssues: [], rows: [], ownerNames: [name], ownerIdentifiers: [{role:'account',value:number}] });
const invalid: AssemblyIssue = { id:'bad',code:'OUTSIDE_TRANSACTION_SOURCES',field:'accountName',severity:'REQUIRED',outputRows:[1],sourceRows:[1,2],sourceCells:[2],message:'wrong source' };

test('repair an invalid owner-name reference only with exact owner and printed header corroboration', () => {
 const {registry}=buildQualitySources([{nearTableText:['户名：测试甲'],tables:[]}]);
 assert.equal(recoverOwnerNames([row('批量业务')],registry,{1:page()},[invalid])[0]?.value,'测试甲');
 assert.equal(recoverOwnerNames([row('另一户名')],registry,{1:page()},[]).length,0,'valid conflicting names remain for review');
 assert.equal(recoverOwnerNames([row()],registry,{1:page('测试甲','009999999999')},[]).length,0);
 assert.equal(recoverOwnerNames([row()],buildQualitySources([{nearTableText:['户名：测试甲乙'],tables:[]}]).registry,{1:page()},[]).length,0,'partial names are not corroboration');
 const other=buildQualitySources([{nearTableText:[],tables:[{rows:[['测试甲']]}]}]).registry;
 assert.equal(recoverOwnerNames([row()],other,{1:page()},[]).length,0,'counterparty table cells cannot establish the owner');
 const conflict=buildQualitySources([{nearTableText:['户名：测试甲'],tables:[]},{nearTableText:['户名：测试乙'],tables:[]}]).registry;
 assert.equal(recoverOwnerNames([row()],conflict,{1:page(),2:page('测试乙')},[]).length,0);
});

test('a combined owner identity header yields the name fragment without copying the identity number', () => {
 const {registry}=buildQualitySources([{nearTableText:[`测试甲110101199001010011 ${account}`],tables:[]}]);
 assert.equal(recoverOwnerNames([row('测试甲110101199001010011')],registry,{1:page()},[])[0]?.value,'测试甲');
});
