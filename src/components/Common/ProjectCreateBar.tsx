import type { ReactNode } from 'react';
import { Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import './ProjectCreateBar.css';

interface Props {
  label: string;
  onCreate: () => void;
  testId: string;
  children?: ReactNode;
}

export default function ProjectCreateBar({ label, onCreate, testId, children }: Props) {
  return (
    <div className="project-create-bar">
      <Button type="primary" icon={<PlusOutlined />} data-testid={testId} onClick={onCreate}>
        {label}
      </Button>
      {children}
    </div>
  );
}
