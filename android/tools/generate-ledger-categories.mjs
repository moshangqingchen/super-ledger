import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expenseCategories, incomeCategories } from '../../assets/ledger-categories.mjs';

// One canonical catalogue for browser, Node and Android. This step is entirely offline.
export function generateLedgerCategories(directory) {
  const target = path.join(directory, 'LedgerCategories.java');
  const array = values => values.map(value => JSON.stringify(value)).join(',');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, `package com.moneylab.superledger.mobile;\npublic final class LedgerCategories {\n private LedgerCategories() {}\n public static final String[] EXPENSE = {${array(expenseCategories)}};\n public static final String[] INCOME = {${array(incomeCategories)}};\n}\n`, 'utf8');
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateLedgerCategories(process.argv[2]);
