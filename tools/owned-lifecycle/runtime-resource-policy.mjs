// Deterministic resource policy, not proof of native cleanup.
export async function initializeHeldJournal(journal,initialize){
  try{return await initialize(journal);}
  catch(original){
    try{await journal.close();original.journalClosed=true;}
    catch(closing){original.journalClosed=false;original.journalCloseFailureCode=closing.fixedCode??'journal_close_failed';}
    throw original;
  }
}
export async function withHeldJournalFinally(operation,journal){
  let value,original,closing;
  try{value=await operation();}catch(e){original=e;}
  finally{try{await journal.close();}catch(e){closing=e;}}
  if(original){original.journalClosed=closing===undefined;if(closing)original.journalCloseFailureCode=closing.fixedCode??'journal_close_failed';throw original;}
  if(closing)throw closing;
  return value;
}
