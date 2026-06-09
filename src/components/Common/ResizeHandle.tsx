import React from 'react';

interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  isDragging: boolean;
  /** Position: 'left' means the handle is on the left edge of the panel */
  position?: 'left' | 'right';
}

const ResizeHandle: React.FC<ResizeHandleProps> = ({
  onPointerDown,
  isDragging,
  position = 'left',
}) => {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 6,
        cursor: 'col-resize',
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: isDragging ? 'none' : 'background-color 0.15s ease',
        ...(position === 'left' ? { left: -3 } : { right: -3 }),
        backgroundColor: isDragging ? 'var(--bg-hover, rgba(0,0,0,0.04))' : 'transparent',
      }}
      onMouseEnter={(e) => {
        if (!isDragging) {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-hover, rgba(0,0,0,0.04))';
        }
      }}
      onMouseLeave={(e) => {
        if (!isDragging) {
          (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
        }
      }}
    >
      <div
        style={{
          width: 2,
          height: 32,
          borderRadius: 1,
          backgroundColor: isDragging ? 'var(--accent-primary, #3b82f6)' : 'var(--border-base, #d9d9d9)',
          opacity: isDragging ? 1 : 0.5,
          transition: isDragging ? 'none' : 'opacity 0.15s ease, background-color 0.15s ease',
        }}
      />
    </div>
  );
};

export default ResizeHandle;
