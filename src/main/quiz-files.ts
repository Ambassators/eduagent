import type { QuizEngine } from './quiz.js';
import type { DocumentStore } from './documents.js';

/** Serializes coach/answer updates so a quiz file always contains the latest progress. */
export class QuizFiles {
  private pending: Promise<void> = Promise.resolve();
  private ids = new Map<string,string>();
  constructor(private quizzes: QuizEngine, private files: DocumentStore, private onError: (error: unknown) => void) {}
  changed() {
    const quiz=this.quizzes.state.quiz;
    if(!quiz)return;
    const content=this.quizzes.exportFile();
    this.pending=this.pending.then(async()=>{
      let id=this.ids.get(quiz.id);
      if(id&&!this.files.list().some(file=>file.id===id))return;
      if(!id){const file=await this.files.create(quiz.title,'quiz',content);id=file.id;this.ids.set(quiz.id,id);}
      else if(this.files.content(id).text!==content)await this.files.updateText(id,content);
    }).catch(this.onError);
  }
  async flush() { await this.pending; }
  async select(id: string) {
    await this.flush();
    const file=this.files.content(id);
    if(file.info.kind==='quiz'){
      const saved=JSON.parse(file.text);
      this.ids.set(saved.id,id);
      if(this.quizzes.state.quiz?.id!==saved.id)this.quizzes.restoreFile(file.text);
    }
    await this.files.select(id);
  }
  isCurrent(id: string) { const quiz=this.quizzes.state.quiz;return !!quiz&&this.ids.get(quiz.id)===id; }
}
