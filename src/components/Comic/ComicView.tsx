import React from 'react';
import { Empty, Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useTranslation } from '@/i18n';

const ComicView: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div style={{ padding: 48, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <Empty
        description={t('comic.empty')}
        image={Empty.PRESENTED_IMAGE_SIMPLE}
      >
        <Button type="primary" icon={<PlusOutlined />}>
          {t('comic.newProject')}
        </Button>
      </Empty>
    </div>
  );
};

export default ComicView;
