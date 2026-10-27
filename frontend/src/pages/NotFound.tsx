import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Section} from '@astryxdesign/core/Section';

export default function Page() {
  return (
    <Section>
      <EmptyState
        headingLevel={1}
        title="Page not found"
        description="That URL does not match anything here."
      />
    </Section>
  );
}
