import { contextFor, orgWideContextFor } from '../testing';
import {
  attachmentVisibilityWhere,
  canSeeAttachment,
  type AttachmentFacts,
} from './attachment.rules';

const worker = contextFor('worker', ['worker']);
const colleague = contextFor('colleague', ['worker']);
const manager = orgWideContextFor('boss', 'manager');

function attachment(overrides: Partial<AttachmentFacts> = {}): AttachmentFacts {
  return {
    status: 'ready',
    uploadedById: 'worker',
    workLog: { authorId: 'worker', siteId: null, teamId: null },
    ...overrides,
  };
}

describe('attachment visibility', () => {
  it('shows a ready attachment to whoever sees the log', () => {
    expect(canSeeAttachment(worker, attachment())).toBe(true);
    expect(canSeeAttachment(manager, attachment())).toBe(true);
    expect(canSeeAttachment(colleague, attachment())).toBe(false);
  });

  it('shows a pending attachment to its uploader only', () => {
    expect(canSeeAttachment(worker, attachment({ status: 'pending' }))).toBe(true);
    expect(canSeeAttachment(manager, attachment({ status: 'pending' }))).toBe(false);
    expect(canSeeAttachment(manager, attachment({ status: 'pending', uploadedById: 'boss' }))).toBe(
      true,
    );
  });

  it('never shows an attachment of a log the caller cannot see, even their own upload', () => {
    expect(
      canSeeAttachment(colleague, attachment({ status: 'pending', uploadedById: 'colleague' })),
    ).toBe(false);
  });

  it('filters the same way in the database', () => {
    expect(attachmentVisibilityWhere(worker)).toMatchObject({
      OR: [{ status: 'ready' }, { uploadedById: 'worker' }],
    });
  });
});
