declare const Prose: (props: { children: React.ReactNode }) => React.ReactNode;

export const _invalid = () => (
  // oxlint-disable-next-line narrative-prose-component/require-prose
  <p>A long narrative explanation belongs in Prose.</p>
);

// expect-clean: narrative-prose-component/require-prose
export const _valid = () => <Prose>A readable narrative explanation.</Prose>;
export const _status = () => <p role="status">Saved</p>;
export const _label = () => <p className="text-xs">Metadata</p>;
export const _table = () => (
  <table>
    <tbody>
      <tr>
        <td>
          <p>Cell value</p>
        </td>
      </tr>
    </tbody>
  </table>
);
