'use client';

import { useEffect, useState } from 'react';
import { lessons, type Lesson } from '@/course/lessons';

const storageKey = 'witness-list/course-progress-v1';

export interface CourseModeProps {
  /** Open the protocol player at the lesson's stage (and update the deep-link hash). */
  onOpenLesson?: (lesson: Lesson) => void;
  /** Highlight the lesson that currently owns the deep link / focused stage. */
  activeLessonId?: string;
}

export function CourseMode({ onOpenLesson, activeLessonId }: CourseModeProps) {
  const [open, setOpen] = useState(false);
  const [complete, setComplete] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved !== null) setComplete(new Set(JSON.parse(saved) as string[]));
    } catch {
      // Local progress is a convenience; a blocked storage area never blocks the workshop.
    }
  }, []);

  useEffect(() => {
    if (activeLessonId !== undefined) setOpen(true);
  }, [activeLessonId]);

  function toggle(id: string): void {
    setComplete((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* optional persistence */
      }
      return next;
    });
  }

  return (
    <section className="course-mode" aria-labelledby="course-title">
      <div className="course-heading">
        <div>
          <p className="eyebrow">Guided course</p>
          <h2 id="course-title">Ten stops from claim to verified proof</h2>
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)}>
          {open ? 'Hide lessons' : `Open lessons (${complete.size}/${lessons.length})`}
        </button>
      </div>
      {open && (
        <ol className="lesson-list">
          {lessons.map((lesson) => (
            <li
              key={lesson.id}
              className={`${complete.has(lesson.id) ? 'complete' : ''} ${activeLessonId === lesson.id ? 'active-lesson' : ''}`}
            >
              <label>
                <input
                  type="checkbox"
                  checked={complete.has(lesson.id)}
                  onChange={() => toggle(lesson.id)}
                />
                <span>
                  <strong>{lesson.title}</strong>
                  <small>Player stage {lesson.stage}</small>
                  <p>{lesson.prompt}</p>
                  <p className="mono">Task: {lesson.task}</p>
                  {onOpenLesson !== undefined && (
                    <button
                      type="button"
                      className="lesson-open"
                      onClick={(event) => {
                        event.preventDefault();
                        onOpenLesson(lesson);
                      }}
                    >
                      Open stage {lesson.stage}
                    </button>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
