import enum


class RoleEnum(str, enum.Enum):
    ADMIN = "ADMIN"
    ANNOTATOR = "ANNOTATOR"
    REVIEWER = "REVIEWER"
    CANDIDATE = "CANDIDATE"


class UploadJobStatusEnum(str, enum.Enum):
    UPLOADED = "UPLOADED"
    VALIDATED = "VALIDATED"
    VALIDATION_FAILED = "VALIDATION_FAILED"
    IMPORTED = "IMPORTED"
    IMPORT_FAILED = "IMPORT_FAILED"


class TaskStatusEnum(str, enum.Enum):
    NOT_STARTED = "Not Started"
    IN_PROGRESS = "In Progress"
    COMPLETED = "Completed"
    NEEDS_REVIEW = "Needs Review"
    REVIEWED = "Reviewed"
    APPROVED = "Approved"
    REJECTED = "Rejected"


class HiringAssessmentStatusEnum(str, enum.Enum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    CLOSED = "CLOSED"


class HiringAssignmentStatusEnum(str, enum.Enum):
    ASSIGNED = "ASSIGNED"
    IN_PROGRESS = "IN_PROGRESS"
    SUBMITTED = "SUBMITTED"
    EVALUATED = "EVALUATED"


class HiringSubmissionValidationStatusEnum(str, enum.Enum):
    PENDING = "PENDING"
    VALIDATED = "VALIDATED"
    REJECTED = "REJECTED"


class HiringDecisionEnum(str, enum.Enum):
    PENDING = "PENDING"
    PASS = "PASS"
    FAIL = "FAIL"
    HOLD = "HOLD"
