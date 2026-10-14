const same = (a: unknown,b: unknown) => JSON.stringify(a)===JSON.stringify(b);
type Row = Record<string, any>;
/** Context already delivered to one coach thread. Reset on rotation or compaction. */
export class QuizCoachContext {
  private previous: Row | null = null;
  private rows = new Map<string,Map<string,Row>>();
  private pages = new Map<string,string>();
  reset() { this.previous=null;this.rows.clear();this.pages.clear(); }
  page(fileId:string,page:number,text:string) {
    const key=`${fileId}:${page}`, unchanged=this.pages.get(key)===text;
    this.pages.set(key,text);return unchanged;
  }
  update(value: Row): Row {
    const old=this.previous;
    const result:Row=old?{contextMode:'delta',contextNote:'Apply these updates to the existing thread context. Array rows are new or changed, keyed by ID. usedQuestionIds is additive. Remove removedQueuedQuestionIds from the queue and removedSourceFileIds from the available source files. Discussion append updates extend that entry; replace updates replace it. Live queue/budget fields remain authoritative.'}:{contextMode:'snapshot',...value};
    const live=new Set(['quizId','status','adaptive','adaptiveMode','total','maxQuestions','buffer','protectedQuestionId','replaceableQuestionIds','remaining','queuedQuestionIds','adaptiveBudget','newAnswersSinceReview']);
    const keyed:Record<string,string>={askedQuestions:'id',queuedQuestions:'id',recentAnswers:'questionId',recentDiscussion:'id',questionBank:'id',sourceDocuments:'fileId'};
    for(const [field,key] of Object.entries(keyed)) {
      const seen=this.rows.get(field)??new Map<string,Row>(), changed:Row[]=[];
      for(const row of value[field]??[]) {
        const id=String(row[key]),previous=seen.get(id);
        if(!same(row,previous)) {
          let update={...row};
          if(field==='recentDiscussion')update={...row,update:previous&&row.text.startsWith(previous.text)?'append':'replace',text:previous&&row.text.startsWith(previous.text)?row.text.slice(previous.text.length):row.text};
          if(field==='sourceDocuments'&&previous) {
            update={fileId:row.fileId};
            for(const [name,data] of Object.entries(row))if(!same(data,previous[name]))update[name]=data;
            if(update.pageOverview)update.pageOverview=update.pageOverview.filter((page:Row)=>!same(page,previous.pageOverview?.find((p:Row)=>p.page===page.page)));
          }
          changed.push(update);seen.set(id,structuredClone(row));
        }
      }
      this.rows.set(field,seen);
      if(old&&changed.length)result[field]=changed;
    }
    if(old) {
      for(const [key,data] of Object.entries(value)) {
        if(key in keyed||key==='contextNote')continue;
        if(key==='usedQuestionIds') {
          const known=new Set(old.usedQuestionIds??[]);const added=data.filter((id:string)=>!known.has(id));
          if(added.length)result.usedQuestionIds=added;
        } else if(key==='stats') {
          const stats:Row={};for(const [name,v] of Object.entries(data)) {
            if(name==='topics') {const changed=(v as Row[]).filter(row=>!same(row,old.stats?.topics?.find((topic:Row)=>topic.topic===row.topic)));if(changed.length)stats.topics=changed;}
            else if(!same(v,old.stats?.[name]))stats[name]=v;
          }
          if(Object.keys(stats).length)result.stats=stats;
        } else if(live.has(key)||!same(data,old[key]))result[key]=data;
      }
      const queued=new Set((value.queuedQuestions??[]).map((q:Row)=>q.id));
      const removed=(old.queuedQuestions??[]).filter((q:Row)=>!queued.has(q.id)).map((q:Row)=>q.id);
      if(removed.length)result.removedQueuedQuestionIds=removed;
      const files=new Set((value.sourceDocuments??[]).map((d:Row)=>d.fileId));
      const removedFiles=(old.sourceDocuments??[]).filter((d:Row)=>!files.has(d.fileId)).map((d:Row)=>d.fileId);
      if(removedFiles.length){result.removedSourceFileIds=removedFiles;for(const id of removedFiles)this.rows.get('sourceDocuments')?.delete(id);}
    }
    this.previous=structuredClone(value);return result;
  }
}
