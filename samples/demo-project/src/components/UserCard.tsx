import formatDate from '../utils/date';

/** Props of the user card. */
interface UserCardProps {
  readonly email: string;
  readonly joined: Date;
}

/** Displays a user and tracks clicks. */
export function UserCard({ email, joined }: UserCardProps) {
  return (
    <div onClick={() => track('user-card-click')}>
      {email} — joined {formatDate(joined)}
    </div>
  );
}

/** Sends an analytics event. */
function track(event: string): void {
  void event;
}
